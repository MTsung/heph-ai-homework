import type { Queryable } from '@chat-app/shared/db';

export interface EventRow {
  id: string;
  type: string;
  text: string | null;
  data: unknown;
  created_at: Date;
}

/** 訂位需求的對話與狀態紀錄(booking_events) */
export class BookingEventRepository {
  constructor(private readonly db: Queryable) {}

  async listForBooking(bookingId: string): Promise<EventRow[]> {
    const { rows } = await this.db.query<EventRow>(
      'SELECT id, type, text, data, created_at FROM booking_events WHERE booking_id = $1 ORDER BY id',
      [bookingId],
    );
    return rows;
  }

  /** 同一則訊息(client_msg_id)是否已經處理過 */
  async hasClientMsg(bookingId: string, clientMsgId: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM booking_events WHERE booking_id = $1 AND client_msg_id = $2', [bookingId, clientMsgId]);
    return !!r.rowCount;
  }

  async addUser(bookingId: string, text: string, clientMsgId: string | null): Promise<void> {
    await this.db.query(`INSERT INTO booking_events (booking_id, type, text, client_msg_id) VALUES ($1,'user',$2,$3)`, [
      bookingId,
      text,
      clientMsgId,
    ]);
  }

  async addAssistant(bookingId: string, text: string, data: unknown): Promise<void> {
    await this.db.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'assistant',$2,$3)`, [
      bookingId,
      text,
      JSON.stringify(data),
    ]);
  }

  async addStatus(bookingId: string, text: string, data: unknown): Promise<void> {
    await this.db.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status',$2,$3)`, [
      bookingId,
      text,
      JSON.stringify(data),
    ]);
  }

  /** 一次記錄多筆「已過期」 */
  async addExpired(bookingIds: string[]): Promise<void> {
    await this.db.query(
      `INSERT INTO booking_events (booking_id, type, text, data)
       SELECT unnest($1::uuid[]), 'status', '已過期', '{"status":"expired"}'::jsonb`,
      [bookingIds],
    );
  }
}
