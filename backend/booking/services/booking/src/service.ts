import { z } from 'zod';
import { AppError, Errors } from '../../../../shared/errors';
import { tx } from '../../../../shared/db';
import { acquireLock, releaseLock } from '../../../../shared/redis';
import { advance, applyPatch, toRef, type Step } from './dialog';
import { newExecRef, newTurnRef, type Deps } from './deps';
import { isBookingIntent, normalizePhone, pickCandidate, todayStr } from './nlu';
import type { Runner } from './runner';
import {
  ACTIVE_DRAFT,
  planHash,
  type BookingRow,
  type BookingStatus,
  type Patch,
  type Plan,
  type Slots,
} from './types';

// ============================================================================ 輸入驗證
const msgId = z.string().min(1).max(64).optional();

export const messageBody = z.object({
  text: z.string().trim().min(1, '訊息不可為空').max(500, '訊息太長(上限 500 字)'),
  client_msg_id: msgId,
});

export const slotsBody = z
  .object({
    client_msg_id: msgId,
    restaurant_id: z.string().min(1).max(64).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD').optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/, '時間格式需為 HH:MM').optional(),
    party_size: z.number().int().min(1).max(50).optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        phone: z.string().max(30).optional(),
        email: z.string().email('電子郵件格式不正確').max(80).optional(),
      })
      .optional(),
    extra: z.record(z.string().max(60)).optional(),
    notes: z.string().max(200).optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'client_msg_id'), '至少要提供一個欄位');

export const createBody = z.object({
  text: messageBody.shape.text,
  client_request_id: z.string().min(1).max(64).optional(),
});
export const confirmBody = z.object({ plan_hash: z.string().min(8).max(64) });

type TurnInput =
  | { kind: 'text'; text: string; msgId?: string }
  | { kind: 'patch'; patch: Patch; pickId?: string; label: string; msgId?: string };

// ============================================================================ 對外呈現
interface EventRow {
  id: string;
  type: string;
  text: string | null;
  data: unknown;
  created_at: Date;
}
interface ChargeView {
  kind: string;
  amount: number;
  state: string;
  note: string;
}

// ============================================================================ 列表
export const LIST_VIEWS = ['attention', 'upcoming', 'in_progress', 'history', 'active', 'all'] as const;
export type ListView = (typeof LIST_VIEWS)[number];
export const HISTORY_RESULTS = ['succeeded', 'failed', 'unknown', 'cancelled', 'expired'] as const;
export interface ListOpts {
  view: ListView;
  limit: number;
  /** 只用於 history */
  result?: (typeof HISTORY_RESULTS)[number];
  includeDrafts?: boolean;
  before?: { at: string; id: string };
}

/** history 的 keyset 分頁游標:(結束時間, id)。不透明字串,用戶端原樣帶回 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${new Date(at).toISOString()}|${id}`).toString('base64url');
}
export function decodeCursor(s: string): { at: string; id: string } | null {
  const [at, id] = Buffer.from(s, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { at, id };
}

const isExpired = (r: Pick<BookingRow, 'status' | 'expires_at'>) =>
  r.status === 'awaiting_confirmation' && !!r.expires_at && new Date(r.expires_at).getTime() <= Date.now();

/** 使用者看得到的條件(去掉內部的訂位連結 / 平台資訊) */
function publicSlots(s: Slots) {
  const { restaurant, ...rest } = s;
  return {
    ...rest,
    restaurant: restaurant && { id: restaurant.id, name: restaurant.name, district: restaurant.district, address: restaurant.address, phone: restaurant.phone },
  };
}

function summarize(s: Slots, plan: Plan | null): string {
  const who = plan?.restaurant.name ?? s.restaurant?.name ?? s.restaurant_query ?? `${s.area ?? ''}${s.cuisine ?? ''}`;
  const when = [s.date, s.time].filter(Boolean).join(' ');
  return [who || '訂位需求', when, s.party_size ? `${s.party_size} 位` : ''].filter(Boolean).join(' · ');
}

export function toView(d: Deps, row: BookingRow, extra: { events?: EventRow[]; charges?: ChargeView[] } = {}) {
  const expired = isExpired(row);
  const status: BookingStatus = expired ? 'expired' : row.status;
  const live = ACTIVE_DRAFT.includes(status);
  return {
    id: row.id,
    status,
    summary: summarize(row.slots, row.plan),
    pending: live ? row.pending : null,
    slots: publicSlots(row.slots),
    plan:
      row.plan && (live || status === 'expired')
        ? { ...row.plan, hash: row.plan_hash, version: row.plan_version, expires_at: row.expires_at, can_confirm: live && status === 'awaiting_confirmation' }
        : null,
    confirmed_plan: row.confirmed_plan ? { ...row.confirmed_plan, hash: planHash(row.confirmed_plan), confirmed_at: row.confirmed_at } : null,
    result: row.result,
    cost: { per_message: d.cfg.turnCost, on_success: d.cfg.bookCost },
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    ...(extra.events
      ? { events: extra.events.map((e) => ({ id: Number(e.id), type: e.type, text: e.text, data: e.data, at: e.created_at })) }
      : {}),
    ...(extra.charges ? { charges: extra.charges } : {}),
  };
}
export type BookingView = ReturnType<typeof toView>;

// ============================================================================ 服務
export class BookingService {
  constructor(
    private readonly d: Deps,
    private readonly runner: Runner,
  ) {}

  // ------------------------------------------------------------------------ 查詢
  private async load(userId: string, id: string): Promise<BookingRow> {
    const { rows } = await this.d.pool.query<BookingRow>('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!rows[0]) throw Errors.notFound('找不到這筆訂位需求');
    return rows[0];
  }

  async get(userId: string, id: string): Promise<BookingView> {
    const row = await this.load(userId, id);
    const [events, charges] = await Promise.all([
      this.d.pool.query<EventRow>('SELECT id, type, text, data, created_at FROM booking_events WHERE booking_id = $1 ORDER BY id', [id]),
      this.d.pool.query<ChargeView>('SELECT kind, amount, state, note FROM charges WHERE booking_id = $1 ORDER BY created_at', [id]),
    ]);
    return toView(this.d, row, { events: events.rows, charges: charges.rows });
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
    const params: unknown[] = [userId];
    const bind = (v: unknown) => `$${params.push(v)}`;
    const live = `status IN ('collecting','awaiting_confirmation','confirmed','executing')`;
    // 「等待確認但已過期」在背景任務落地前也算過期
    const pendingFresh = `(status = 'awaiting_confirmation' AND (expires_at IS NULL OR expires_at > now()))`;
    const pendingStale = `(status = 'awaiting_confirmation' AND expires_at <= now())`;
    const finished = `(status IN ('succeeded','failed','unknown','cancelled','expired') OR ${pendingStale})`;
    const planDate = `(confirmed_plan->>'date')`;
    const today = () => bind(todayStr(new Date())); // 用餐日以台北日期比較(與 NLU 解析日期的基準相同)
    const where: Record<ListView, () => string> = {
      attention: () => `((status = 'unknown' AND ${planDate} >= ${today()}) OR ${pendingFresh})`,
      upcoming: () => `(status = 'succeeded' AND ${planDate} >= ${today()})`,
      in_progress: () => `status IN ('collecting','confirmed','executing')`,
      history: () => finished,
      active: () => live,
      all: () => 'true',
    };
    const order: Record<ListView, string> = {
      attention: `CASE WHEN status = 'unknown' THEN 0 ELSE 1 END, updated_at DESC, id DESC`,
      upcoming: `${planDate}, (confirmed_plan->>'time'), id`,
      in_progress: 'updated_at DESC, id DESC',
      history: 'coalesce(finished_at, updated_at) DESC, id DESC',
      active: 'updated_at DESC, id DESC',
      all: 'updated_at DESC, id DESC',
    };
    const filters: string[] = [`user_id = $1`, where[opts.view]()];
    if (opts.view === 'history') {
      if (!opts.includeDrafts) filters.push('confirmed_plan IS NOT NULL');
      if (opts.result === 'expired') filters.push(`(status = 'expired' OR ${pendingStale})`);
      else if (opts.result) filters.push(`status = ${bind(opts.result)}`);
      if (opts.before) {
        filters.push(`(coalesce(finished_at, updated_at), id) < (${bind(opts.before.at)}::timestamptz, ${bind(opts.before.id)}::uuid)`);
      }
    }
    const limit = bind(opts.limit + 1);
    const { rows } = await this.d.pool.query<BookingRow>(
      `SELECT * FROM bookings WHERE ${filters.join(' AND ')} ORDER BY ${order[opts.view]} LIMIT ${limit}`,
      params,
    );
    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((r) => {
      const v = toView(this.d, r);
      const plan = r.confirmed_plan ?? r.plan;
      return {
        id: v.id,
        status: v.status,
        summary: v.summary,
        pending_kind: v.pending?.kind ?? null,
        expires_at: v.status === 'awaiting_confirmation' ? r.expires_at : null,
        // 列表直接顯示「哪家、哪天幾點、幾位」,不必逐筆再查詳情
        restaurant: plan ? { name: plan.restaurant.name, phone: plan.restaurant.phone ?? null, address: plan.restaurant.address } : null,
        date: plan?.date ?? r.slots.date ?? null,
        time: plan?.time ?? r.slots.time ?? null,
        party_size: plan?.party_size ?? r.slots.party_size ?? null,
        result: v.result,
        updated_at: v.updated_at,
        finished_at: v.finished_at,
      };
    });
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

  async create(userId: string, b: z.infer<typeof createBody>): Promise<{ view: BookingView; created: boolean }> {
    if (!isBookingIntent(b.text)) {
      throw new AppError(422, 'NOT_BOOKING_INTENT', '這看起來不是訂位需求,請當作一般聊天處理');
    }
    const active = await this.d.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM bookings WHERE user_id = $1 AND status IN ('collecting','awaiting_confirmation')`,
      [userId],
    );
    if (Number(active.rows[0]!.n) >= this.d.cfg.maxActivePerUser) {
      throw Errors.conflict('TOO_MANY_ACTIVE', `進行中的訂位需求已達上限(${this.d.cfg.maxActivePerUser} 筆),請先完成或取消其中幾筆`);
    }
    const ins = await this.d.pool.query<{ id: string }>(
      `INSERT INTO bookings (user_id, client_request_id, status) VALUES ($1, $2, 'collecting')
       ON CONFLICT (user_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING RETURNING id`,
      [userId, b.client_request_id ?? null],
    );
    if (!ins.rows[0]) {
      // 同一個 client_request_id 重送(例如網路斷線後重試):回傳原本那筆,不重複建立、不重複扣點
      const ex = await this.d.pool.query<{ id: string }>('SELECT id FROM bookings WHERE user_id = $1 AND client_request_id = $2', [userId, b.client_request_id]);
      return { view: await this.get(userId, ex.rows[0]!.id), created: false };
    }
    const id = ins.rows[0].id;
    try {
      await this.turn(userId, id, { kind: 'text', text: b.text, msgId: 'create' });
    } catch (e) {
      // 第一輪就失敗(點數不足、搜尋服務壞了…):不留下空殼
      await this.d.pool.query('DELETE FROM bookings WHERE id = $1 AND version = 0', [id]).catch(() => undefined);
      throw e;
    }
    return { view: await this.get(userId, id), created: true };
  }

  // ------------------------------------------------------------------------ 對話
  async message(userId: string, id: string, b: z.infer<typeof messageBody>): Promise<BookingView> {
    await this.turn(userId, id, { kind: 'text', text: b.text, msgId: b.client_msg_id });
    return this.get(userId, id);
  }

  /** 結構化輸入(按鈕 / 表單):不經過 AI,所以不扣點 */
  async setSlots(userId: string, id: string, b: z.infer<typeof slotsBody>): Promise<BookingView> {
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

  /**
   * 處理一輪對話。順序是整個正確性的關鍵:
   *   1. 取得這筆需求的鎖(同時只處理一個操作;鎖只是為了不重複花錢 / 呼叫,最終正確性靠第 5 步的條件式更新)
   *   2. 文字訊息先預扣點數(點數不足就在做任何事之前失敗)
   *   3. 理解需求 → 套用 → 問店家 → 決定下一步
   *   4. 在同一個 transaction 內:更新狀態(樂觀鎖)+ 寫入對話紀錄 + 決定這筆扣點的結局(結算)
   *   5. 中途任何一步失敗:放棄預扣,使用者不會被扣點
   */
  private async turn(userId: string, id: string, input: TurnInput): Promise<void> {
    const { d } = this;
    const token = await acquireLock(d.redis, `lock:bk:${id}`, 60_000);
    if (!token) throw Errors.conflict('TURN_IN_PROGRESS', '上一個操作還在處理中,請稍後再試');
    let chargeRef: string | null = null;
    try {
      const row = await this.load(userId, id);
      if (input.msgId) {
        const dup = await d.pool.query('SELECT 1 FROM booking_events WHERE booking_id = $1 AND client_msg_id = $2', [id, input.msgId]);
        if (dup.rowCount) return; // 同一則訊息重送:已經處理過,不重複扣點
      }
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
    } finally {
      await releaseLock(d.redis, `lock:bk:${id}`, token).catch(() => undefined);
    }
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
      const upd = await c.query<BookingRow>(
        `UPDATE bookings SET status = $3, slots = $4, pending = $5, candidates = $6,
                plan = $7, plan_hash = $8, plan_version = plan_version + $9::int,
                expires_at = CASE WHEN $7::jsonb IS NULL THEN NULL WHEN $9::int = 1 THEN now() + make_interval(secs => $10) ELSE expires_at END,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND version = $2 AND status IN ('collecting','awaiting_confirmation')
          RETURNING id`,
        [
          row.id,
          row.version,
          step.status,
          JSON.stringify(step.slots),
          JSON.stringify(step.pending),
          step.candidates ? JSON.stringify(step.candidates) : null,
          step.plan ? JSON.stringify(sameAsBefore ? row.plan : step.plan) : null,
          hash,
          newPlan ? 1 : 0,
          d.cfg.planTtlSec,
        ],
      );
      if (!upd.rowCount) throw Errors.conflict('CONFLICT', '這筆訂位剛剛被其他操作更新了,請重新整理後再試');
      await c.query(`INSERT INTO booking_events (booking_id, type, text, client_msg_id) VALUES ($1,'user',$2,$3)`, [row.id, userText, input.msgId ?? null]);
      await c.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'assistant',$2,$3)`, [
        row.id,
        step.message,
        JSON.stringify({ pending_kind: step.pending.kind }), // 完整的待辦事項在 booking.pending;歷史裡只記種類,避免每則都重複夾帶候選清單
      ]);
      if (newPlan) {
        await c.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status',$2,$3)`, [
          row.id,
          `方案已產生(第 ${row.plan_version + 1} 版),請在 ${Math.round(d.cfg.planTtlSec / 60)} 分鐘內確認`,
          JSON.stringify({ status: step.status, plan_hash: hash }),
        ]);
      } else if (row.status === 'awaiting_confirmation' && step.status === 'collecting') {
        await c.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status',$2,$3)`, [
          row.id,
          '條件有變動,原方案已作廢',
          JSON.stringify({ status: step.status }),
        ]);
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
  async confirm(userId: string, id: string, planHashIn: string): Promise<BookingView> {
    // 同一筆需求同時只處理一個「改動」(對話或確認),否則兩個並發的確認會共用同一個名額 / 預扣
    const token = await acquireLock(this.d.redis, `lock:bk:${id}`, 60_000);
    if (!token) throw Errors.conflict('TURN_IN_PROGRESS', '上一個操作還在處理中,請稍後再試');
    try {
      return await this.confirmLocked(userId, id, planHashIn);
    } finally {
      await releaseLock(this.d.redis, `lock:bk:${id}`, token).catch(() => undefined);
    }
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
      throw Errors.conflict('PLAN_CHANGED', '方案已經更新,請確認最新的內容後再送出', { current: toView(d, row).plan });
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
        const r = await c.query(
          `UPDATE bookings SET status = 'confirmed', confirmed_plan = plan, confirmed_at = now(), exec_phase = 'pre_submit',
                  charge_ref = $3, pending = NULL, version = version + 1, updated_at = now()
            WHERE id = $1 AND status = 'awaiting_confirmation' AND plan_hash = $2 AND expires_at > now()`,
          [id, planHashIn, ref],
        );
        if (!r.rowCount) return false;
        await c.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status',$2,$3)`, [
          id,
          '已確認,開始向店家送出訂位',
          JSON.stringify({ status: 'confirmed', plan_hash: planHashIn }),
        ]);
        return true;
      });
      if (!ok) {
        // 在檢查之後、提交之前,方案過期了或被改掉:放棄
        await d.charges.abort(ref);
        await giveBack();
        const now = await this.load(userId, id);
        d.metrics.confirms.labels('lost_race').inc();
        if (isExpired(now)) throw Errors.conflict('PLAN_EXPIRED', '方案已過期,不能再確認。請重新建立訂位需求');
        throw Errors.conflict('PLAN_CHANGED', '方案剛剛被更新了,請確認最新的內容後再送出', { current: toView(d, now).plan });
      }
    } catch (e) {
      if (!(e instanceof AppError && ['PLAN_EXPIRED', 'PLAN_CHANGED'].includes(e.code))) {
        await giveBack();
        if (e instanceof AppError) d.metrics.confirms.labels(e.code).inc();
      }
      throw e;
    }
    d.metrics.confirms.labels('ok').inc();
    this.runner.start(id);
    return this.get(userId, id);
  }

  // ------------------------------------------------------------------------ 取消
  async cancel(userId: string, id: string): Promise<BookingView> {
    const r = await this.d.pool.query<{ id: string }>(
      `UPDATE bookings SET status = 'cancelled', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('collecting','awaiting_confirmation') RETURNING id`,
      [id, userId],
    );
    if (r.rowCount) {
      await this.d.pool.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status','已取消','{"status":"cancelled"}')`, [id]);
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
    const r = await this.d.pool.query(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'awaiting_confirmation' AND expires_at <= now()`,
      [id],
    );
    if (r.rowCount) {
      await this.d.pool.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status','方案已過期,不能再確認','{"status":"expired"}')`, [id]);
    }
  }
}
