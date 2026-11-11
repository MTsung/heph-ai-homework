import type { Queryable } from '@chat-app/shared/db';

export interface AccountRow {
  user_id: string;
  balance: string;
  held: string;
}

export class AccountRepository {
  constructor(private readonly db: Queryable) {}

  async find(userId: string): Promise<Pick<AccountRow, 'balance' | 'held'> | undefined> {
    const { rows } = await this.db.query<AccountRow>('SELECT balance, held FROM accounts WHERE user_id = $1', [userId]);
    return rows[0];
  }

  async findMany(userIds: string[]): Promise<AccountRow[]> {
    const { rows } = await this.db.query<AccountRow>(
      'SELECT user_id, balance, held FROM accounts WHERE user_id = ANY($1::uuid[])',
      [userIds],
    );
    return rows;
  }

  /** 建立帳戶(已存在就不動)。回傳是否新建立 */
  async createIfAbsent(userId: string, initialBalance: number): Promise<boolean> {
    const r = await this.db.query(
      `INSERT INTO accounts (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, initialBalance],
    );
    return !!r.rowCount;
  }

  async addBalance(userId: string, amount: number): Promise<number> {
    const r = await this.db.query<{ balance: string }>(
      `UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance`,
      [userId, amount],
    );
    return Number(r.rows[0]!.balance);
  }

  async releaseHeld(userId: string, amount: number): Promise<void> {
    await this.db.query('UPDATE accounts SET held = held - $2, updated_at = now() WHERE user_id = $1', [userId, amount]);
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
  }

  /** 後台總覽:帳戶、預扣、帳本的彙總 */
  async overview(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM accounts) AS accounts,
              (SELECT coalesce(sum(balance),0) FROM accounts) AS total_balance,
              (SELECT coalesce(sum(held),0) FROM accounts) AS total_held,
              (SELECT count(*) FROM holds WHERE status = 'held') AS active_holds,
              (SELECT coalesce(sum(amount),0) FROM ledger WHERE type = 'grant') AS total_granted,
              (SELECT coalesce(-sum(amount),0) FROM ledger WHERE type = 'charge') AS total_charged,
              (SELECT count(*) FROM ledger WHERE type = 'charge' AND created_at > now() - interval '24 hours') AS charges_24h`,
    );
    return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]));
  }
}
