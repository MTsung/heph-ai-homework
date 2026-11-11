import type { Queryable } from '@chat-app/shared/db';
import type { Device } from '../types';

export interface SessionRow {
  sid: string;
  device_name: string;
}

export class SessionRepository {
  constructor(private readonly db: Queryable) {}

  async findByUser(userId: string): Promise<SessionRow | undefined> {
    const { rows } = await this.db.query<SessionRow>('SELECT sid, device_name FROM sessions WHERE user_id = $1', [userId]);
    return rows[0];
  }

  /** 必須在 transaction 內呼叫:鎖住該使用者的 session 列,讓同一位使用者的並發登入序列化 */
  async lockByUser(userId: string): Promise<SessionRow | undefined> {
    const { rows } = await this.db.query<SessionRow>('SELECT sid, device_name FROM sessions WHERE user_id = $1 FOR UPDATE', [
      userId,
    ]);
    return rows[0];
  }

  /** 每位使用者只有一個 session(單一裝置):新的直接覆蓋舊的 */
  async upsert(s: { userId: string; sid: string; device: Device; ip: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (user_id, sid, device_id, device_name, ip)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET sid = EXCLUDED.sid, device_id = EXCLUDED.device_id,
             device_name = EXCLUDED.device_name, ip = EXCLUDED.ip, created_at = now()`,
      [s.userId, s.sid, s.device.device_id, s.device.device_name, s.ip],
    );
  }

  /** 刪除 session;指定 onlySid 時只在 sid 相符才刪。回傳被刪掉的 sid(沒有則 null) */
  async delete(userId: string, onlySid?: string): Promise<string | null> {
    const r = onlySid
      ? await this.db.query<{ sid: string }>('DELETE FROM sessions WHERE user_id = $1 AND sid = $2 RETURNING sid', [userId, onlySid])
      : await this.db.query<{ sid: string }>('DELETE FROM sessions WHERE user_id = $1 RETURNING sid', [userId]);
    return r.rows[0]?.sid ?? null;
  }
}
