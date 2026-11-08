import { z } from 'zod';
import { buildApp, onShutdown, readJson } from '../../../shared/app';
import { channels, envInt } from '../../../shared/config';
import { createPool, migrate, waitForDb } from '../../../shared/db';
import { Errors, parse } from '../../../shared/errors';
import { CacheAside, CacheStats, createRedis } from '../../../shared/redis';
import { characterSeeds } from './seed';

const CACHE_TTL_SEC = envInt('CHARACTER_CACHE_TTL_SEC', 600);

interface CharacterRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  avatar: string;
  persona: string;
  greeting: string;
  price: number;
  model: string | null;
  status: 'active' | 'disabled';
  sort_order: number;
  updated_at: string;
}

/** 對一般使用者公開的欄位。persona(system prompt)屬於內部資料,不外洩。 */
function publicView(c: CharacterRow) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    tagline: c.tagline,
    avatar: c.avatar,
    greeting: c.greeting,
    price: c.price,
  };
}

const upsertSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  name: z.string().min(1).max(32),
  tagline: z.string().max(100).default(''),
  avatar: z.string().min(1).max(8).default('🙂'),
  // 人設(system prompt)每次請求都要重送給模型並計費,是固定的輸入成本,所以限制長度。預設角色約 170 字
  persona: z.string().min(1).max(1000),
  greeting: z.string().min(1).max(500),
  price: z.number().int().min(0).max(1000),
  model: z.string().max(64).nullable().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  sort_order: z.number().int().default(100),
});

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

async function main(): Promise<void> {
  const pool = createPool('character');
  const redis = createRedis('character'); // state:pub/sub、統計
  const cacheRedis = createRedis('character', 'cache'); // cache:角色資料
  const { app, log, listen } = buildApp({
    service: 'character',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
      await cacheRedis.ping();
    },
  });
  const stats = new CacheStats(redis, 'character');
  stats.start();
  const cache = new CacheAside(cacheRedis, 'char', stats, log);

  await waitForDb(pool);
  await migrate(pool, 'character', [
    {
      id: '001_init',
      sql: `
CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  tagline text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '🙂',
  persona text NOT NULL,
  greeting text NOT NULL,
  price int NOT NULL DEFAULT 2 CHECK (price >= 0),
  model text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`,
    },
  ]);
  for (const s of characterSeeds) {
    await pool.query(
      `INSERT INTO characters (slug, name, tagline, avatar, persona, greeting, price, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.name, s.tagline, s.avatar, s.persona, s.greeting, s.price, s.sort_order],
    );
  }

  const COLS = 'id, slug, name, tagline, avatar, persona, greeting, price, model, status, sort_order, updated_at';

  async function invalidate(id?: string): Promise<void> {
    await cache.del('list', ...(id ? [`id:${id}`] : []));
    await redis.publish(channels.characterEvents, JSON.stringify({ id: id ?? null })).catch(() => undefined);
  }

  const listActive = () =>
    cache.get('list', CACHE_TTL_SEC, async () => {
      const { rows } = await pool.query<CharacterRow>(
        `SELECT ${COLS} FROM characters WHERE status = 'active' ORDER BY sort_order, name`,
      );
      return rows.map(publicView);
    });

  const getById = (id: string) =>
    cache.get<CharacterRow>(`id:${id}`, CACHE_TTL_SEC, async () => {
      const { rows } = await pool.query<CharacterRow>(`SELECT ${COLS} FROM characters WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });

  // ---------------------------------------------------------------- 對外
  app.get('/characters', async (c) => c.json({ items: (await listActive()) ?? [] }));

  app.get('/characters/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw Errors.notFound('角色不存在');
    const ch = await getById(id);
    if (!ch || ch.status !== 'active') throw Errors.notFound('角色不存在');
    return c.json(publicView(ch));
  });

  // ---------------------------------------------------------------- 內部
  app.get('/internal/characters/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw Errors.notFound('角色不存在');
    const ch = await getById(id);
    if (!ch) throw Errors.notFound('角色不存在');
    return c.json(ch);
  });

  app.get('/internal/characters', async (c) => {
    const { rows } = await pool.query<CharacterRow>(`SELECT ${COLS} FROM characters ORDER BY sort_order, name`);
    return c.json({ items: rows });
  });

  app.post('/internal/characters', async (c) => {
    const b = parse(upsertSchema, await readJson(c));
    try {
      const { rows } = await pool.query<CharacterRow>(
        `INSERT INTO characters (slug, name, tagline, avatar, persona, greeting, price, model, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`,
        [b.slug, b.name, b.tagline, b.avatar, b.persona, b.greeting, b.price, b.model ?? null, b.status, b.sort_order],
      );
      await invalidate();
      return c.json(rows[0], 201);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('SLUG_TAKEN', 'slug 已存在');
      throw e;
    }
  });

  app.put('/internal/characters/:id', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) throw Errors.notFound('角色不存在');
    const b = parse(upsertSchema, await readJson(c));
    const { rows } = await pool.query<CharacterRow>(
      `UPDATE characters SET slug=$2, name=$3, tagline=$4, avatar=$5, persona=$6, greeting=$7,
              price=$8, model=$9, status=$10, sort_order=$11, updated_at=now()
        WHERE id=$1 RETURNING ${COLS}`,
      [id, b.slug, b.name, b.tagline, b.avatar, b.persona, b.greeting, b.price, b.model ?? null, b.status, b.sort_order],
    );
    if (!rows[0]) throw Errors.notFound('角色不存在');
    // 先寫 DB 再刪快取;並廣播,讓各服務清掉自己的本機快取
    await invalidate(id);
    return c.json(rows[0]);
  });

  const server = listen(envInt('PORT', 3002));
  log.info({ port: server.port }, 'character listening');
  onShutdown(log, async () => {
    stats.stop();
    await stats.flush();
    await server.stop();
    await pool.end();
    redis.disconnect();
    cacheRedis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
