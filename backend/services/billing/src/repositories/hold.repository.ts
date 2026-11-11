import type { Queryable } from '@chat-app/shared/db';

/**
 * 預扣(reserve)。重點:
 *   UPDATE accounts SET held = held + $amt WHERE user_id = $1 AND balance - held >= $amt
 * 「檢查餘額」與「扣除」是同一個原子 SQL,在 row lock 下序列化,
 * 所以 N 個並發請求搶最後幾點時,不可能超扣,也不需要應用層的鎖。
 *
 * 熱路徑:整個預扣是「一條語句、一次往返、一次 commit」。
 * 單一語句本身就是原子的(含 CTE 內的多個 UPDATE/INSERT),不需要 BEGIN/COMMIT 往返。
 *   ex  :這個 ref 是否已經預扣過(冪等)
 *   upd :條件式扣除 —— 餘額夠才會更新到列;已有同 ref 的 hold 時不執行
 *   ins :只在 upd 成功時寫入 hold。用一般 INSERT(不用 ON CONFLICT),
 *        若兩個相同 ref 的請求同時到達,後者會因 PK 衝突讓「整條語句」回滾,
 *        不會出現「held 已增加、hold 卻沒寫入」的半套狀態。
 */
const HOLD_SQL = `
    WITH ex AS (SELECT status, amount FROM holds WHERE ref = $1),
    upd AS (
      UPDATE accounts SET held = held + $3, updated_at = now()
       WHERE user_id = $2 AND balance - held >= $3 AND NOT EXISTS (SELECT 1 FROM ex)
       RETURNING balance, held
    ),
    ins AS (
      INSERT INTO holds (ref, user_id, amount, status, expires_at)
      SELECT $1, $2, $3, 'held', now() + make_interval(secs => $4) FROM upd
      RETURNING ref
    )
    SELECT (SELECT status FROM ex) AS ex_status, (SELECT amount FROM ex) AS ex_amount,
           (SELECT balance FROM upd) AS balance, (SELECT held FROM upd) AS held,
           (SELECT count(*) FROM ins)::int AS inserted`;

/**
 * 結算同樣是單一語句:hold 轉 settled → 扣 balance 與 held → 寫帳本,三者原子完成。
 * 只有 hold 目前是 'held' 時 h 才有列;重送(已結算)時 h 為空,整條語句不改任何東西。
 */
const SETTLE_SQL = `
    WITH h AS (
      UPDATE holds SET status = 'settled', resolved_at = now()
       WHERE ref = $1 AND status = 'held' RETURNING user_id, amount
    ),
    a AS (
      UPDATE accounts SET balance = balance - h.amount, held = held - h.amount, updated_at = now()
        FROM h WHERE accounts.user_id = h.user_id
      RETURNING accounts.user_id, accounts.balance
    ),
    l AS (
      INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note, meta)
      SELECT h.user_id, 'charge', -h.amount, a.balance, coalesce($4::text, 'message'), $1, 'charge:' || $1, $2, $3::jsonb
        FROM h JOIN a ON a.user_id = h.user_id WHERE h.amount > 0
      ON CONFLICT (idem_key) DO NOTHING RETURNING id
    )
    SELECT (SELECT user_id FROM h) AS user_id, (SELECT balance FROM a) AS balance`;

export interface HoldAttempt {
  ex_status: string | null;
  ex_amount: number | null;
  balance: string | null;
  held: string | null;
  inserted: number;
}

export class HoldRepository {
  constructor(private readonly db: Queryable) {}

  /** 同 ref 並發建立時丟 PostgreSQL 23505(整條語句已回滾) */
  async tryHold(h: { ref: string; userId: string; amount: number; ttlSec: number }): Promise<HoldAttempt> {
    const r = await this.db.query<HoldAttempt>(HOLD_SQL, [h.ref, h.userId, h.amount, h.ttlSec]);
    return r.rows[0]!;
  }

  /** user_id 為 null 表示沒有可結算的 hold(已結算、已釋放或不存在) */
  async settle(s: { ref: string; note: string; meta: string; refType: string | null }): Promise<{ user_id: string | null; balance: string | null }> {
    const r = await this.db.query<{ user_id: string | null; balance: string | null }>(SETTLE_SQL, [s.ref, s.note, s.meta, s.refType]);
    return r.rows[0]!;
  }

  async findStatus(ref: string): Promise<string | undefined> {
    const r = await this.db.query<{ status: string }>('SELECT status FROM holds WHERE ref = $1', [ref]);
    return r.rows[0]?.status;
  }

  /** held → released。回傳被釋放的 hold(不存在 / 已結算 / 已釋放則 null) */
  async markReleased(ref: string): Promise<{ user_id: string; amount: number } | null> {
    const h = await this.db.query<{ user_id: string; amount: number }>(
      `UPDATE holds SET status = 'released', resolved_at = now()
        WHERE ref = $1 AND status = 'held' RETURNING user_id, amount`,
      [ref],
    );
    return h.rows[0] ?? null;
  }

  /** 必須在 transaction 內呼叫:鎖住一批逾時的 hold */
  async lockExpired(limit: number): Promise<Array<{ ref: string; user_id: string; amount: number }>> {
    const { rows } = await this.db.query<{ ref: string; user_id: string; amount: number }>(
      `SELECT ref, user_id, amount FROM holds
        WHERE status = 'held' AND expires_at < now()
        ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows;
  }

  async setReleased(ref: string): Promise<void> {
    await this.db.query(`UPDATE holds SET status = 'released', resolved_at = now() WHERE ref = $1`, [ref]);
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM holds WHERE user_id = $1', [userId]);
  }
}
