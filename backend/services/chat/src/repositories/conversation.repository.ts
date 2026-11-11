import type { Queryable } from '@chat-app/shared/db';
import type { ConversationView } from '../types';

const VIEW_COLS = 'id, character_id, last_message_at, last_preview, next_seq - 1 AS latest_seq, created_at';

export class ConversationRepository {
  constructor(private readonly db: Queryable) {}

  async listByUser(userId: string): Promise<ConversationView[]> {
    const { rows } = await this.db.query<ConversationView>(
      `SELECT ${VIEW_COLS}
         FROM conversations WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 200`,
      [userId],
    );
    return rows;
  }

  async findByUserAndCharacter(userId: string, characterId: string): Promise<ConversationView | undefined> {
    const { rows } = await this.db.query<ConversationView>(
      `SELECT ${VIEW_COLS}
         FROM conversations WHERE user_id = $1 AND character_id = $2`,
      [userId, characterId],
    );
    return rows[0];
  }

  /**
   * 建立對話(同一位使用者 + 角色只會有一條)。next_seq 從 2 開始:seq=1 留給開場白。
   * 回傳新對話 id;已存在則 null。
   */
  async insertIfAbsent(id: string, userId: string, characterId: string): Promise<string | null> {
    const ins = await this.db.query<{ id: string }>(
      `INSERT INTO conversations (id, user_id, character_id, next_seq)
       VALUES ($1, $2, $3, 2) ON CONFLICT (user_id, character_id) DO NOTHING RETURNING id`,
      [id, userId, characterId],
    );
    return ins.rows[0]?.id ?? null;
  }

  async setPreview(id: string, preview: string): Promise<void> {
    await this.db.query('UPDATE conversations SET last_preview = $2 WHERE id = $1', [id, preview]);
  }

  async findOwner(id: string): Promise<{ user_id: string; character_id: string } | undefined> {
    const { rows } = await this.db.query<{ user_id: string; character_id: string }>(
      'SELECT user_id, character_id FROM conversations WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async nextSeq(id: string): Promise<number | undefined> {
    const { rows } = await this.db.query<{ next_seq: number }>('SELECT next_seq FROM conversations WHERE id = $1', [id]);
    return rows[0]?.next_seq;
  }

  async listIdsByUser(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>('SELECT id FROM conversations WHERE user_id = $1', [userId]);
    return rows.map((r) => r.id);
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.db.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
  }

  // ---------------------------------------------------------------- 後台
  async listForAdmin(userId: string, limit: number): Promise<unknown[]> {
    const { rows } = await this.db.query(
      `SELECT id, user_id, character_id, last_message_at, last_preview, next_seq - 1 AS latest_seq, created_at
         FROM conversations WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }
}
