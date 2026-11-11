import type { Queryable } from '@chat-app/shared/db';
import { todayStr } from '../domain/nlu';
import type { ListOpts, ListView } from '../schemas';
import type { BookingResult, BookingRow, BookingStatus, Candidate, Pending, Plan, Slots } from '../types';

export class BookingRepository {
  constructor(private readonly db: Queryable) {}

  // ---------------------------------------------------------------- 讀取
  async findById(id: string): Promise<BookingRow | undefined> {
    const { rows } = await this.db.query<BookingRow>('SELECT * FROM bookings WHERE id = $1', [id]);
    return rows[0];
  }

  async findOwned(id: string, userId: string): Promise<BookingRow | undefined> {
    const { rows } = await this.db.query<BookingRow>('SELECT * FROM bookings WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0];
  }

  async findIdByClientRequest(userId: string, clientRequestId: string | undefined): Promise<string | undefined> {
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM bookings WHERE user_id = $1 AND client_request_id = $2', [
      userId,
      clientRequestId,
    ]);
    return rows[0]?.id;
  }

  async countActiveDrafts(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM bookings WHERE user_id = $1 AND status IN ('collecting','awaiting_confirmation')`,
      [userId],
    );
    return Number(rows[0]!.n);
  }

  /**
   * 訂位列表(依 view 分組,見 BookingService.list 的說明)。多拿一筆用來判斷是否還有下一頁。
   */
  async listForUser(userId: string, opts: ListOpts): Promise<BookingRow[]> {
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
    const { rows } = await this.db.query<BookingRow>(
      `SELECT * FROM bookings WHERE ${filters.join(' AND ')} ORDER BY ${order[opts.view]} LIMIT ${limit}`,
      params,
    );
    return rows;
  }

  // ---------------------------------------------------------------- 草稿
  /** 建立草稿;同一個 client_request_id 已存在時回傳 null */
  async insertDraft(userId: string, clientRequestId: string | null): Promise<string | null> {
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO bookings (user_id, client_request_id, status) VALUES ($1, $2, 'collecting')
       ON CONFLICT (user_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING RETURNING id`,
      [userId, clientRequestId],
    );
    return ins.rows[0]?.id ?? null;
  }

  /** 刪掉還沒任何進展(version = 0)的空殼 */
  async deleteUntouched(id: string): Promise<void> {
    await this.db.query('DELETE FROM bookings WHERE id = $1 AND version = 0', [id]);
  }

  /** 一輪對話後的狀態更新(樂觀鎖:version 必須相同)。回傳是否更新到 */
  async applyTurn(u: {
    id: string;
    version: number;
    status: BookingStatus;
    slots: Slots;
    pending: Pending;
    candidates: Candidate[] | null | undefined;
    /** undefined = 這一步沒有方案(寫入 NULL) */
    plan: Plan | null | undefined;
    planHash: string | null;
    newPlan: boolean;
    planTtlSec: number;
  }): Promise<boolean> {
    const upd = await this.db.query(
      `UPDATE bookings SET status = $3, slots = $4, pending = $5, candidates = $6,
              plan = $7, plan_hash = $8, plan_version = plan_version + $9::int,
              expires_at = CASE WHEN $7::jsonb IS NULL THEN NULL WHEN $9::int = 1 THEN now() + make_interval(secs => $10) ELSE expires_at END,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2 AND status IN ('collecting','awaiting_confirmation')
        RETURNING id`,
      [
        u.id,
        u.version,
        u.status,
        JSON.stringify(u.slots),
        JSON.stringify(u.pending),
        u.candidates ? JSON.stringify(u.candidates) : null,
        u.plan !== undefined ? JSON.stringify(u.plan) : null,
        u.planHash,
        u.newPlan ? 1 : 0,
        u.planTtlSec,
      ],
    );
    return !!upd.rowCount;
  }

  /**
   * 確認方案:只有「狀態仍是 awaiting_confirmation、雜湊相同、尚未過期(用資料庫的時間)」才會成功,
   * 同時把方案複製到 confirmed_plan。回傳是否更新到
   */
  async confirm(id: string, planHash: string, chargeRef: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE bookings SET status = 'confirmed', confirmed_plan = plan, confirmed_at = now(), exec_phase = 'pre_submit',
              charge_ref = $3, pending = NULL, version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'awaiting_confirmation' AND plan_hash = $2 AND expires_at > now()`,
      [id, planHash, chargeRef],
    );
    return !!r.rowCount;
  }

  async cancel(id: string, userId: string): Promise<boolean> {
    const r = await this.db.query<{ id: string }>(
      `UPDATE bookings SET status = 'cancelled', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status IN ('collecting','awaiting_confirmation') RETURNING id`,
      [id, userId],
    );
    return !!r.rowCount;
  }

  async expireOne(id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'awaiting_confirmation' AND expires_at <= now()`,
      [id],
    );
    return !!r.rowCount;
  }

  // ---------------------------------------------------------------- 執行(租約)
  async claim(id: string, owner: string, leaseSec: number): Promise<BookingRow | null> {
    const r = await this.db.query<BookingRow>(
      `UPDATE bookings
          SET status = 'executing', lease_owner = $2, lease_until = now() + make_interval(secs => $3),
              attempt = attempt + 1, version = version + 1, updated_at = now()
        WHERE id = $1 AND (status = 'confirmed' OR (status = 'executing' AND lease_until < now()))
        RETURNING *`,
      [id, owner, leaseSec],
    );
    return r.rows[0] ?? null;
  }

  async unclaim(id: string, owner: string): Promise<void> {
    await this.db.query(
      `UPDATE bookings SET status = 'confirmed', lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
      [id, owner],
    );
  }

  async renewLease(id: string, owner: string, leaseSec: number): Promise<void> {
    await this.db.query(
      `UPDATE bookings SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
      [id, owner, leaseSec],
    );
  }

  /** write-ahead:送出請求「之前」先記下 submitting。回傳 false = 執行權已經被別人拿走 */
  async markSubmitting(id: string, owner: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE bookings SET exec_phase = 'submitting', updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
      [id, owner],
    );
    return !!r.rowCount;
  }

  /** 寫入最終結果。回傳 false = 已經由別人結束了 */
  async finish(id: string, status: BookingStatus, result: BookingResult): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE bookings
          SET status = $2, result = $3, pending = NULL, exec_phase = NULL, lease_owner = NULL, lease_until = NULL,
              finished_at = now(), updated_at = now(), version = version + 1
        WHERE id = $1 AND status IN ('executing','confirmed')`,
      [id, status, JSON.stringify(result)],
    );
    return !!r.rowCount;
  }

  // ---------------------------------------------------------------- 背景任務
  /** 確認期限已到的方案 → expired */
  async expirePlans(): Promise<string[]> {
    const r = await this.db.query<{ id: string }>(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'awaiting_confirmation' AND expires_at < now() RETURNING id`,
    );
    return r.rows.map((x) => x.id);
  }

  /** 太久沒動的草稿 → expired */
  async expireStaleDrafts(draftTtlSec: number): Promise<string[]> {
    const r = await this.db.query<{ id: string }>(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'collecting' AND updated_at < now() - make_interval(secs => $1) RETURNING id`,
      [draftTtlSec],
    );
    return r.rows.map((x) => x.id);
  }

  /** 已確認、但沒有人在執行的訂位 */
  async listUnattended(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM bookings
        WHERE status IN ('confirmed','executing') AND (lease_until IS NULL OR lease_until < now())
          AND updated_at < now() - interval '5 seconds'
        ORDER BY updated_at LIMIT 10`,
    );
    return rows.map((r) => r.id);
  }

  /** 對話、扣點紀錄隨 ON DELETE CASCADE 一併刪除。回傳刪除筆數 */
  async deleteByUser(userId: string): Promise<number> {
    const r = await this.db.query('DELETE FROM bookings WHERE user_id = $1', [userId]);
    return r.rowCount ?? 0;
  }

  // ---------------------------------------------------------------- 後台
  async listByUser(userId: string, limit: number): Promise<BookingRow[]> {
    const { rows } = await this.db.query<BookingRow>('SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [
      userId,
      limit,
    ]);
    return rows;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM bookings GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}
