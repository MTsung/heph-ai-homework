import type { Queryable } from '@chat-app/shared/db';

/**
 * 預扣之後、訊息寫入之前就失敗時,補償用的 release 若也失敗,就記在這裡,由 reaper 重試到成功。
 * (此時還沒有 messages 列可以掛 billing_state)
 */
export class PendingReleaseRepository {
  constructor(private readonly db: Queryable) {}

  async add(holdRef: string): Promise<void> {
    await this.db.query('INSERT INTO pending_releases (hold_ref) VALUES ($1) ON CONFLICT DO NOTHING', [holdRef]);
  }

  async listOldest(limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ hold_ref: string }>(
      `SELECT hold_ref FROM pending_releases ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.hold_ref);
  }

  async remove(holdRef: string): Promise<void> {
    await this.db.query('DELETE FROM pending_releases WHERE hold_ref = $1', [holdRef]);
  }

  async recordAttempt(holdRef: string): Promise<void> {
    await this.db.query('UPDATE pending_releases SET attempts = attempts + 1 WHERE hold_ref = $1', [holdRef]);
  }
}
