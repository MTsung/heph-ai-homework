import type { Queryable } from '@chat-app/shared/db';
import type { CharacterSeed } from '../db/seed';
import type { CharacterInput } from '../schemas';
import type { CharacterRow } from '../types';

const COLS = 'id, slug, name, tagline, avatar, persona, greeting, price, model, status, sort_order, updated_at';

export class CharacterRepository {
  constructor(private readonly db: Queryable) {}

  async listActive(): Promise<CharacterRow[]> {
    const { rows } = await this.db.query<CharacterRow>(
      `SELECT ${COLS} FROM characters WHERE status = 'active' ORDER BY sort_order, name`,
    );
    return rows;
  }

  async listAll(): Promise<CharacterRow[]> {
    const { rows } = await this.db.query<CharacterRow>(`SELECT ${COLS} FROM characters ORDER BY sort_order, name`);
    return rows;
  }

  async findById(id: string): Promise<CharacterRow | null> {
    const { rows } = await this.db.query<CharacterRow>(`SELECT ${COLS} FROM characters WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** slug 重複時丟 PostgreSQL 23505 */
  async insert(b: CharacterInput): Promise<CharacterRow> {
    const { rows } = await this.db.query<CharacterRow>(
      `INSERT INTO characters (slug, name, tagline, avatar, persona, greeting, price, model, status, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
      [b.slug, b.name, b.tagline, b.avatar, b.persona, b.greeting, b.price, b.model ?? null, b.status, b.sort_order],
    );
    return rows[0]!;
  }

  async update(id: string, b: CharacterInput): Promise<CharacterRow | undefined> {
    const { rows } = await this.db.query<CharacterRow>(
      `UPDATE characters SET slug=$2, name=$3, tagline=$4, avatar=$5, persona=$6, greeting=$7,
              price=$8, model=$9, status=$10, sort_order=$11, updated_at=now()
        WHERE id=$1 RETURNING ${COLS}`,
      [id, b.slug, b.name, b.tagline, b.avatar, b.persona, b.greeting, b.price, b.model ?? null, b.status, b.sort_order],
    );
    return rows[0];
  }

  /** 以 slug 做 insert-if-absent:後台修改過的內容不會被重啟覆蓋 */
  async insertSeedIfAbsent(s: CharacterSeed): Promise<void> {
    await this.db.query(
      `INSERT INTO characters (slug, name, tagline, avatar, persona, greeting, price, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.name, s.tagline, s.avatar, s.persona, s.greeting, s.price, s.sort_order],
    );
  }
}
