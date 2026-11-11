import type { Queryable } from '@chat-app/shared/db';

export type ChargeKind = 'turn' | 'exec';

export interface ChargeRow {
  ref: string;
  booking_id: string;
  kind: ChargeKind;
  amount: number;
  note: string;
  state: string;
}

/** 使用者看得到的扣點紀錄 */
export interface ChargeView {
  kind: string;
  amount: number;
  state: string;
  note: string;
}

/** 訂位服務自己的扣點狀態(charges);每筆對應 billing 的一個預扣 ref */
export class ChargeRepository {
  constructor(private readonly db: Queryable) {}

  async insertHolding(c: { ref: string; bookingId: string; userId: string; kind: ChargeKind; amount: number; note: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO charges (ref, booking_id, user_id, kind, amount, note, state)
       VALUES ($1,$2,$3,$4,$5,$6,'holding') ON CONFLICT (ref) DO NOTHING`,
      [c.ref, c.bookingId, c.userId, c.kind, c.amount, c.note],
    );
  }

  async find(ref: string): Promise<ChargeRow | undefined> {
    const { rows } = await this.db.query<ChargeRow>('SELECT ref, booking_id, kind, amount, note, state FROM charges WHERE ref = $1', [ref]);
    return rows[0];
  }

  /** 狀態轉移:只有目前狀態在 from 之內才更新。回傳是否更新到 */
  async transition(ref: string, to: string, from: string[]): Promise<boolean> {
    const r = await this.db.query('UPDATE charges SET state = $2, updated_at = now() WHERE ref = $1 AND state = ANY($3::text[])', [
      ref,
      to,
      from,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * 預扣之後流程就中斷了(程序當機)的扣點 → release_pending。
   * turn 幾秒就會結束;exec 則要看訂位本身是否還在進行中。
   */
  async abandonStale(): Promise<void> {
    await this.db.query(
      `UPDATE charges c SET state = 'release_pending', updated_at = now()
        WHERE c.state IN ('holding','held') AND c.updated_at < now() - interval '2 minutes'
          AND (c.kind = 'turn' OR NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.id = c.booking_id AND b.charge_ref = c.ref AND b.status IN ('confirmed','executing')))`,
    );
  }

  async listPending(limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ ref: string }>(
      `SELECT ref FROM charges WHERE state IN ('settle_pending','release_pending') AND updated_at < now() - interval '5 seconds'
        ORDER BY updated_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.ref);
  }

  async listForBooking(bookingId: string): Promise<ChargeView[]> {
    const { rows } = await this.db.query<ChargeView>('SELECT kind, amount, state, note FROM charges WHERE booking_id = $1 ORDER BY created_at', [
      bookingId,
    ]);
    return rows;
  }

  /** 後台用:含 ref 與時間 */
  async listForBookingAdmin(bookingId: string): Promise<unknown[]> {
    const { rows } = await this.db.query(
      'SELECT ref, kind, amount, state, note, created_at, updated_at FROM charges WHERE booking_id = $1 ORDER BY created_at',
      [bookingId],
    );
    return rows;
  }

  async countByState(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ state: string; n: string }>('SELECT state, count(*) AS n FROM charges GROUP BY state');
    return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  }
}
