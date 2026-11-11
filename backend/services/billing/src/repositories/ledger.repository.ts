import type { Queryable } from '@chat-app/shared/db';

export interface LedgerRow {
  id: string;
  type: string;
  amount: string;
  balance_after: string;
  ref_type: string;
  ref_id: string;
  note: string;
  meta: unknown;
  created_at: Date;
}

export class LedgerRepository {
  constructor(private readonly db: Queryable) {}

  /** 註冊贈點(以 signup:{uid} 為冪等鍵) */
  async insertSignupGrant(userId: string, amount: number): Promise<void> {
    await this.db.query(
      `INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note)
       VALUES ($1,'grant',$2,$2,'signup',$3,$4,'註冊贈點') ON CONFLICT (idem_key) DO NOTHING`,
      [userId, amount, userId, `signup:${userId}`],
    );
  }

  async existsIdem(idemKey: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM ledger WHERE idem_key = $1', [idemKey]);
    return !!r.rowCount;
  }

  /** 入帳紀錄。回傳是否寫入(false = 同 idem_key 已存在) */
  async insertGrant(g: { userId: string; amount: number; balanceAfter: number; idemKey: string; note: string }): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note)
       VALUES ($1,'grant',$2,$3,'grant',$4,$4,$5) ON CONFLICT (idem_key) DO NOTHING`,
      [g.userId, g.amount, g.balanceAfter, g.idemKey, g.note],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** keyset 分頁:WHERE id < cursor ORDER BY id DESC,走 (user_id, id DESC) 索引,不論翻到多深都是 O(limit) */
  async list(userId: string, beforeId: number | null, limit: number): Promise<LedgerRow[]> {
    const { rows } = await this.db.query<LedgerRow>(
      `SELECT id, type, amount, balance_after, ref_type, ref_id, note, meta, created_at
         FROM ledger WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`,
      [userId, beforeId, limit],
    );
    return rows;
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM ledger WHERE user_id = $1', [userId]);
  }
}
