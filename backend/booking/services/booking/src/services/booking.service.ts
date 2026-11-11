import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { tx } from '@chat-app/shared/db';
import { AppError, Errors } from '@chat-app/shared/errors';
import { acquireLock, releaseLock } from '@chat-app/shared/redis';
import type { BookingConfig } from '../config';
import { advance, applyPatch, toRef, type Step } from '../domain/dialog';
import { isBookingIntent, normalizePhone, pickCandidate, type Nlu } from '../domain/nlu';
import type { ChannelRegistry } from '../integrations/channels';
import type { SearchProvider } from '../integrations/search';
import type { Metrics } from '../metrics';
import { BookingEventRepository } from '../repositories/booking-event.repository';
import { BookingRepository } from '../repositories/booking.repository';
import type { ChargeRepository } from '../repositories/charge.repository';
import type { CreateInput, ListOpts, MessageInput, SlotsInput } from '../schemas';
import { ACTIVE_DRAFT, isExpired, planHash, type BookingRow, type Patch, type Slots } from '../types';
import { encodeCursor, toListItem, toView, type BookingView } from '../views/booking.view';
import type { BookingRunner } from './booking-runner';
import { newExecRef, newTurnRef, type ChargeService } from './charge.service';
import type { ConcurrencyLimiter } from './concurrency-limiter';

type TurnInput =
  | { kind: 'text'; text: string; msgId?: string }
  | { kind: 'patch'; patch: Patch; pickId?: string; label: string; msgId?: string };

export interface BookingServiceDeps {
  pool: Pool;
  redis: Redis;
  chargeRepo: ChargeRepository;
  charges: ChargeService;
  nlu: Nlu;
  search: SearchProvider;
  channels: ChannelRegistry;
  limiter: ConcurrencyLimiter;
  runner: BookingRunner;
  metrics: Metrics;
  cfg: BookingConfig;
}

const lockKey = (id: string) => `lock:bk:${id}`;

export class BookingService {
  private readonly bookings: BookingRepository;
  private readonly events: BookingEventRepository;

  constructor(private readonly d: BookingServiceDeps) {
    this.bookings = new BookingRepository(d.pool);
    this.events = new BookingEventRepository(d.pool);
  }

  // ------------------------------------------------------------------------ 查詢
  private async load(userId: string, id: string): Promise<BookingRow> {
    const row = await this.bookings.findOwned(id, userId);
    if (!row) throw Errors.notFound('找不到這筆訂位需求');
    return row;
  }

  async get(userId: string, id: string): Promise<BookingView> {
    const row = await this.load(userId, id);
    const [events, charges] = await Promise.all([this.events.listForBooking(id), this.d.chargeRepo.listForBooking(id)]);
    return toView(this.d.cfg, row, { events, charges });
  }

  /**
   * 訂位列表。依「使用者接下來要做什麼」分組(view):
   *   attention    需要你處理:結果不明且用餐日還沒過(請向店家確認)、等你確認且未過期的方案
   *   upcoming     即將到來:訂位成功且用餐日 >= 今天(台北),依用餐時間排序
   *   in_progress  進行中:補資料中、已確認、正在訂位
   *   history      訂位紀錄:所有已結束的(成功 / 失敗 / 結果不明 / 取消 / 過期),依結束時間新到舊、可分頁。
   *                預設不含「沒確認過方案就取消 / 過期」的草稿(include_drafts=true 才列出)
   *   active / all 舊的查法(相容):進行中含等待確認 / 全部
   */
  async list(userId: string, opts: ListOpts) {
    const rows = await this.bookings.listForUser(userId, opts);
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((r) => toListItem(this.d.cfg, r));
    const last = page[page.length - 1];
    const nextBefore =
      opts.view === 'history' && hasMore && last ? encodeCursor(last.finished_at ?? last.updated_at, last.id) : null;
    if (opts.view === 'active' || opts.view === 'all') {
      // 舊的查法:進行中的在前面(使用者「回來看」時最想看到的)
      const rank = (s: string) => (['collecting', 'awaiting_confirmation', 'confirmed', 'executing'].includes(s) ? 0 : 1);
      items.sort((a, b) => rank(a.status) - rank(b.status));
    }
    return { items, next_before: nextBefore };
  }

  // ------------------------------------------------------------------------ 建立
  /** 第一道關卡:不花點數的規則判斷 */
  detect(text: string): { is_booking: boolean } {
    return { is_booking: isBookingIntent(text) };
  }

  async create(userId: string, b: CreateInput): Promise<{ view: BookingView; created: boolean }> {
    if (!isBookingIntent(b.text)) {
      throw new AppError(422, 'NOT_BOOKING_INTENT', '這看起來不是訂位需求,請當作一般聊天處理');
    }
    if ((await this.bookings.countActiveDrafts(userId)) >= this.d.cfg.maxActivePerUser) {
      throw Errors.conflict('TOO_MANY_ACTIVE', `進行中的訂位需求已達上限(${this.d.cfg.maxActivePerUser} 筆),請先完成或取消其中幾筆`);
    }
    const id = await this.bookings.insertDraft(userId, b.client_request_id ?? null);
    if (!id) {
      // 同一個 client_request_id 重送(例如網路斷線後重試):回傳原本那筆,不重複建立、不重複扣點
      const existing = await this.bookings.findIdByClientRequest(userId, b.client_request_id);
      return { view: await this.get(userId, existing!), created: false };
    }
    try {
      await this.turn(userId, id, { kind: 'text', text: b.text, msgId: 'create' });
    } catch (e) {
      // 第一輪就失敗(點數不足、搜尋服務壞了…):不留下空殼
      await this.bookings.deleteUntouched(id).catch(() => undefined);
      throw e;
    }
    return { view: await this.get(userId, id), created: true };
  }

  // ------------------------------------------------------------------------ 對話
  async message(userId: string, id: string, b: MessageInput): Promise<BookingView> {
    await this.turn(userId, id, { kind: 'text', text: b.text, msgId: b.client_msg_id });
    return this.get(userId, id);
  }

  /** 結構化輸入(按鈕 / 表單):不經過 AI,所以不扣點 */
  async setSlots(userId: string, id: string, b: SlotsInput): Promise<BookingView> {
    const patch: Patch = {};
    if (b.date) patch.date = b.date;
    if (b.time) patch.time = b.time;
    if (b.party_size) patch.party_size = b.party_size;
    if (b.notes) patch.notes = b.notes;
    if (b.extra) patch.extra = b.extra;
    if (b.contact) {
      const c = { ...b.contact };
      if (c.phone !== undefined) {
        const p = normalizePhone(c.phone);
        if (!p) throw Errors.badRequest('contact.phone:電話格式不正確');
        c.phone = p;
      }
      patch.contact = c;
    }
    const labels = [b.restaurant_id && '餐廳', b.date && '日期', b.time && '時間', b.party_size && '人數', b.contact && '聯絡資料', b.extra && '其他資料', b.notes && '備註'].filter(Boolean);
    await this.turn(userId, id, { kind: 'patch', patch, pickId: b.restaurant_id, label: `提供:${labels.join('、')}`, msgId: b.client_msg_id });
    return this.get(userId, id);
  }

  /** 同一筆需求同時只處理一個「改動」(對話或確認),否則兩個並發的操作會重複花錢 / 共用同一個名額 */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const token = await acquireLock(this.d.redis, lockKey(id), 60_000);
    if (!token) throw Errors.conflict('TURN_IN_PROGRESS', '上一個操作還在處理中,請稍後再試');
    try {
      return await fn();
    } finally {
      await releaseLock(this.d.redis, lockKey(id), token).catch(() => undefined);
    }
  }

  /**
   * 處理一輪對話。順序是整個正確性的關鍵:
   *   1. 取得這筆需求的鎖(同時只處理一個操作;鎖只是為了不重複花錢 / 呼叫,最終正確性靠第 5 步的條件式更新)
   *   2. 文字訊息先預扣點數(點數不足就在做任何事之前失敗)
   *   3. 理解需求 → 套用 → 問店家 → 決定下一步
   *   4. 在同一個 transaction 內:更新狀態(樂觀鎖)+ 寫入對話紀錄 + 決定這筆扣點的結局(結算)
   *   5. 中途任何一步失敗:放棄預扣,使用者不會被扣點
   */
  private turn(userId: string, id: string, input: TurnInput): Promise<void> {
    return this.withLock(id, async () => {
      const { d } = this;
      let chargeRef: string | null = null;
      try {
        const row = await this.load(userId, id);
        if (input.msgId && (await this.events.hasClientMsg(id, input.msgId))) return; // 同一則訊息重送:已經處理過,不重複扣點
        if (isExpired(row)) {
          await this.expireOne(id);
          throw Errors.conflict('PLAN_EXPIRED', '這份方案已經過期,請重新建立訂位需求');
        }
        if (!ACTIVE_DRAFT.includes(row.status)) throw Errors.conflict('INVALID_STATE', `這筆訂位目前是「${row.status}」,不能再修改`);

        if (input.kind === 'text') {
          chargeRef = newTurnRef(id);
          await d.charges.begin({
            ref: chargeRef,
            bookingId: id,
            userId,
            kind: 'turn',
            amount: d.cfg.turnCost,
            note: '訂位代辦:AI 理解需求',
            ttlSec: 120,
          });
        }

        // ---- 理解 + 套用
        const now = new Date();
        let base: Slots = row.slots;
        let patch: Patch;
        let picked = false;
        if (input.kind === 'text') {
          const pend = row.pending;
          const pick = pend?.kind === 'choose_restaurant' ? pickCandidate(input.text, pend.options) : null;
          if (pick) base = this.pick(row, pick);
          picked = !!pick;
          const u = await d.nlu.understand(input.text, {
            now,
            slots: base,
            expect: pend?.kind === 'provide_info' ? pend.fields : [],
            allowName: !base.restaurant,
          });
          d.metrics.nlu.labels(u.source).inc();
          patch = u.patch;
        } else {
          patch = input.patch;
          if (input.pickId) {
            base = this.pick(row, input.pickId);
            picked = true;
          }
        }
        const applied = applyPatch(base, patch, now);
        if (input.kind === 'text' && !picked && Object.keys(patch).length === 0) {
          applied.notes.unshift(
            row.pending?.kind === 'confirm_plan'
              ? '方案沒有變動。要送出請按「確認」;要修改請直接告訴我新的條件(例如:改成 8 點)。\n'
              : '我沒有從這句話裡找到可以用的資訊。\n',
          );
        }

        // ---- 決定下一步
        const step = await advance(applied.slots, applied.notes, {
          search: d.search,
          channels: d.channels,
          now,
          planTtlSec: d.cfg.planTtlSec,
          bookCost: d.cfg.bookCost,
        });

        await this.commitTurn(row, step, input, chargeRef);
        d.metrics.turns.labels('ok').inc();
        if (chargeRef) await d.charges.finalize(chargeRef);
      } catch (e) {
        d.metrics.turns.labels(e instanceof AppError ? e.code : 'error').inc();
        if (chargeRef) await d.charges.abort(chargeRef); // 沒有提交成功 → 歸還預扣
        throw e;
      }
    });
  }

  /** 使用者從「我提供過的候選清單」裡選一家。只接受清單內的店,不能指定任意的 id */
  private pick(row: BookingRow, restaurantId: string): Slots {
    const c = row.candidates?.find((x) => x.id === restaurantId);
    if (!c) throw new AppError(400, 'INVALID_CHOICE', '這家店不在目前的候選清單裡');
    const s: Slots = structuredClone(row.slots);
    s.restaurant = toRef(c);
    delete s.restaurant_query;
    delete s.extra;
    return s;
  }

  private async commitTurn(row: BookingRow, step: Step, input: TurnInput, chargeRef: string | null): Promise<void> {
    const { d } = this;
    const sameAsBefore = step.plan && row.plan_hash === planHash(step.plan);
    const hash = step.plan ? planHash(step.plan) : null;
    const newPlan = !!step.plan && !sameAsBefore;
    const userText = input.kind === 'text' ? input.text : input.label;

    await tx(d.pool, async (c) => {
      const updated = await new BookingRepository(c).applyTurn({
        id: row.id,
        version: row.version,
        status: step.status,
        slots: step.slots,
        pending: step.pending,
        candidates: step.candidates,
        plan: step.plan ? (sameAsBefore ? row.plan : step.plan) : undefined,
        planHash: hash,
        newPlan,
        planTtlSec: d.cfg.planTtlSec,
      });
      if (!updated) throw Errors.conflict('CONFLICT', '這筆訂位剛剛被其他操作更新了,請重新整理後再試');
      const events = new BookingEventRepository(c);
      await events.addUser(row.id, userText, input.msgId ?? null);
      // 完整的待辦事項在 booking.pending;歷史裡只記種類,避免每則都重複夾帶候選清單
      await events.addAssistant(row.id, step.message, { pending_kind: step.pending.kind });
      if (newPlan) {
        await events.addStatus(row.id, `方案已產生(第 ${row.plan_version + 1} 版),請在 ${Math.round(d.cfg.planTtlSec / 60)} 分鐘內確認`, {
          status: step.status,
          plan_hash: hash,
        });
      } else if (row.status === 'awaiting_confirmation' && step.status === 'collecting') {
        await events.addStatus(row.id, '條件有變動,原方案已作廢', { status: step.status });
      }
      if (chargeRef) await d.charges.commitIn(c, chargeRef, 'settle');
    });
  }

  // ------------------------------------------------------------------------ 確認
  /**
   * 確認方案。「使用者確認了什麼,就只能送出那個」由三道檢查共同保證:
   *   1. 呼叫端必須帶上它看到的方案雜湊(plan_hash),和目前方案不同 → 409 PLAN_CHANGED
   *   2. 條件式 UPDATE:只有「狀態仍是 awaiting_confirmation、雜湊相同、尚未過期(用資料庫的時間)」才會成功,
   *      同時把方案複製到 confirmed_plan
   *   3. confirmed_plan 有 trigger 保護,之後不可修改;執行時只讀這一欄
   */
  confirm(userId: string, id: string, planHashIn: string): Promise<BookingView> {
    return this.withLock(id, () => this.confirmLocked(userId, id, planHashIn));
  }

  private async confirmLocked(userId: string, id: string, planHashIn: string): Promise<BookingView> {
    const { d } = this;
    const row = await this.load(userId, id);

    // 重送同一份確認:回傳目前進度,不重複執行
    if (row.confirmed_plan) {
      if (planHash(row.confirmed_plan) === planHashIn) return this.get(userId, id);
      throw Errors.conflict('ALREADY_CONFIRMED', '這筆訂位已經確認過另一份方案');
    }
    if (isExpired(row)) {
      await this.expireOne(id);
      d.metrics.confirms.labels('expired').inc();
      throw Errors.conflict('PLAN_EXPIRED', '方案已過期,不能再確認。請重新建立訂位需求');
    }
    if (row.status !== 'awaiting_confirmation' || !row.plan) {
      throw Errors.conflict('INVALID_STATE', `這筆訂位目前是「${row.status}」,沒有可確認的方案`);
    }
    if (row.plan_hash !== planHashIn) {
      d.metrics.confirms.labels('plan_changed').inc();
      throw Errors.conflict('PLAN_CHANGED', '方案已經更新,請確認最新的內容後再送出', { current: toView(d.cfg, row).plan });
    }

    const plan = row.plan;
    const channel = d.channels[plan.target.channel];

    // 需要操作網頁的管道:先搶「同時執行」名額,搶不到就回繁忙(什麼都還沒改變、也還沒扣點)
    if (channel.limited) {
      const ok = await d.limiter.acquire(id).catch(() => false);
      if (!ok) {
        d.metrics.busy.inc();
        d.metrics.confirms.labels('busy').inc();
        throw new AppError(503, 'SERVER_BUSY', '目前同時處理訂位的人數已滿,請稍後再試', { retry_after: d.cfg.busyRetryAfterSec });
      }
    }
    const giveBack = () => (channel.limited ? d.limiter.release(id).catch(() => undefined) : Promise.resolve());

    const ref = newExecRef(id);
    try {
      // 預扣訂位費用(點數不足 → 402,方案維持原狀,使用者儲值後可以再確認)
      await d.charges.begin({
        ref,
        bookingId: id,
        userId,
        kind: 'exec',
        amount: d.cfg.bookCost,
        note: `訂位代辦:${plan.restaurant.name} ${plan.date} ${plan.time} ${plan.party_size} 位`,
        ttlSec: 900,
      });
      const ok = await tx(d.pool, async (c) => {
        if (!(await new BookingRepository(c).confirm(id, planHashIn, ref))) return false;
        await new BookingEventRepository(c).addStatus(id, '已確認,開始向店家送出訂位', { status: 'confirmed', plan_hash: planHashIn });
        return true;
      });
      if (!ok) {
        // 在檢查之後、提交之前,方案過期了或被改掉:放棄
        await d.charges.abort(ref);
        await giveBack();
        const now = await this.load(userId, id);
        d.metrics.confirms.labels('lost_race').inc();
        if (isExpired(now)) throw Errors.conflict('PLAN_EXPIRED', '方案已過期,不能再確認。請重新建立訂位需求');
        throw Errors.conflict('PLAN_CHANGED', '方案剛剛被更新了,請確認最新的內容後再送出', { current: toView(d.cfg, now).plan });
      }
    } catch (e) {
      if (!(e instanceof AppError && ['PLAN_EXPIRED', 'PLAN_CHANGED'].includes(e.code))) {
        await giveBack();
        if (e instanceof AppError) d.metrics.confirms.labels(e.code).inc();
      }
      throw e;
    }
    d.metrics.confirms.labels('ok').inc();
    d.runner.start(id);
    return this.get(userId, id);
  }

  // ------------------------------------------------------------------------ 取消
  async cancel(userId: string, id: string): Promise<BookingView> {
    if (await this.bookings.cancel(id, userId)) {
      await this.events.addStatus(id, '已取消', { status: 'cancelled' });
    } else {
      const row = await this.load(userId, id);
      if (row.status !== 'cancelled') {
        throw Errors.conflict('CANNOT_CANCEL', row.confirmed_plan ? '訂位已經送出處理,無法取消。請直接聯絡店家' : `這筆訂位目前是「${row.status}」,無法取消`);
      }
    }
    return this.get(userId, id);
  }

  // ------------------------------------------------------------------------ 過期
  private async expireOne(id: string): Promise<void> {
    if (await this.bookings.expireOne(id)) {
      await this.events.addStatus(id, '方案已過期,不能再確認', { status: 'expired' });
    }
  }

  // ------------------------------------------------------------------------ 刪除帳號
  /** 對話、扣點紀錄隨 ON DELETE CASCADE 一併刪除。回傳刪除的訂位筆數 */
  deleteUserData(userId: string): Promise<number> {
    return this.bookings.deleteByUser(userId);
  }
}
