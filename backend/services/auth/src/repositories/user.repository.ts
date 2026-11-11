import type { Queryable } from '@chat-app/shared/db';
import type { UserSearchQuery } from '../schemas';
import type { UserRow } from '../types';

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  /** 帳號重複時丟 PostgreSQL 23505 */
  async insert(u: { id: string; username: string; passwordHash: string; nickname: string }): Promise<void> {
    await this.db.query('INSERT INTO users (id, username, password_hash, nickname) VALUES ($1, $2, $3, $4)', [
      u.id,
      u.username,
      u.passwordHash,
      u.nickname,
    ]);
  }

  async findByUsername(username: string): Promise<UserRow | undefined> {
    const { rows } = await this.db.query<UserRow>(
      'SELECT id, username, nickname, password_hash, created_at FROM users WHERE username = $1',
      [username],
    );
    return rows[0];
  }

  async findProfile(id: string): Promise<Omit<UserRow, 'password_hash'> | undefined> {
    const { rows } = await this.db.query<UserRow>('SELECT id, username, nickname, created_at FROM users WHERE id = $1', [id]);
    return rows[0];
  }

  async findPasswordHash(id: string): Promise<string | undefined> {
    const { rows } = await this.db.query<Pick<UserRow, 'password_hash'>>('SELECT password_hash FROM users WHERE id = $1', [id]);
    return rows[0]?.password_hash;
  }

  /** sessions 由 ON DELETE CASCADE 一併刪除 */
  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE id = $1', [id]);
  }

  // ---------------------------------------------------------------- 後台
  async search(q: UserSearchQuery): Promise<unknown[]> {
    const like = `%${(q.q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await this.db.query(
      `SELECT u.id, u.username, u.nickname, u.created_at,
              s.device_name, s.created_at AS session_started_at
         FROM users u LEFT JOIN sessions s ON s.user_id = u.id
        WHERE u.username ILIKE $1 OR u.nickname ILIKE $1
        ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [like, q.limit, q.offset],
    );
    return rows;
  }

  async findWithSession(id: string): Promise<unknown | undefined> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.username, u.nickname, u.created_at, s.device_name, s.created_at AS session_started_at
         FROM users u LEFT JOIN sessions s ON s.user_id = u.id WHERE u.id = $1`,
      [id],
    );
    return rows[0];
  }

  async stats(): Promise<{ users: number; active_sessions: number; new_users_24h: number }> {
    const { rows } = await this.db.query<{ users: string; sessions: string; users_24h: string }>(
      `SELECT (SELECT count(*) FROM users) AS users,
              (SELECT count(*) FROM sessions) AS sessions,
              (SELECT count(*) FROM users WHERE created_at > now() - interval '24 hours') AS users_24h`,
    );
    const r = rows[0]!;
    return { users: Number(r.users), active_sessions: Number(r.sessions), new_users_24h: Number(r.users_24h) };
  }
}
