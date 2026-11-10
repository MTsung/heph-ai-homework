import { Pool, PoolClient } from 'pg';
import { env, envInt } from './config';

export function createPool(service: string): Pool {
  const pool = new Pool({
    connectionString: env('DATABASE_URL'),
    max: envInt('PG_POOL_MAX', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: envInt('PG_STATEMENT_TIMEOUT_MS', 10_000),
    application_name: service,
  });
  pool.on('error', (err) => {
    // idle client 出錯(例如 DB 重啟)不應讓整個程序掛掉;下次取用時會重連
    console.error(JSON.stringify({ level: 'error', service, msg: 'pg pool error', err: err.message }));
  });
  return pool;
}

export async function waitForDb(pool: Pool, retries = 60): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 連線可能已斷,忽略 */
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface Migration {
  id: string;
  /** up:往前套用 */
  sql: string;
  /**
   * down:倒退(可選)。沒有 down 的 migration 無法倒退。
   * 只有「不會弄丟資料」的變更才適合寫 down(例如加欄位、加表、加索引);
   * 建立整批資料表的 001_init 刻意不提供,避免一次指令清光所有資料。
   */
  down?: string;
}

/**
 * 極簡 migration:依序執行尚未套用的 SQL,記錄在 schema_migrations。
 * 用 advisory lock 避免多個 replica 同時啟動時重複執行。
 */
export async function migrate(pool: Pool, service: string, migrations: Migration[]): Promise<void> {
  const client = await pool.connect();
  try {
    // 連線池的 statement_timeout(預設 10 秒)不適用於這裡:
    // 滾動更新時,後啟動的 replica 要等先啟動的那個跑完 migration 才拿得到鎖,
    // 等鎖本身也算在 statement_timeout 內,慢的 migration(例如大表建索引)會讓它逾時、反覆重啟。
    await client.query(`SELECT set_config('statement_timeout', '0', false)`);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${service}`]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.id} 失敗:${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${service}`]);
      // 這條連線會回到連線池,要還原逾時設定
      await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(envInt('PG_STATEMENT_TIMEOUT_MS', 10_000))]);
    } finally {
      client.release();
    }
  }
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
  appliedAt?: Date;
  hasDown: boolean;
}

/** 目前各 migration 是否已套用(唯讀) */
export async function migrationStatus(pool: Pool, migrations: Migration[]): Promise<MigrationStatus[]> {
  const exists = await pool.query(`SELECT to_regclass('schema_migrations') AS t`);
  const applied = new Map<string, Date>();
  if (exists.rows[0].t) {
    const { rows } = await pool.query<{ id: string; applied_at: Date }>('SELECT id, applied_at FROM schema_migrations');
    for (const r of rows) applied.set(r.id, r.applied_at);
  }
  return migrations.map((m) => ({ id: m.id, applied: applied.has(m.id), appliedAt: applied.get(m.id), hasDown: !!m.down }));
}

/**
 * 倒退最後 `steps` 個「已套用」的 migration(依 migrations 陣列的順序,由後往前)。
 *  - 每個 migration 的 down 與刪除 schema_migrations 紀錄在同一個 transaction,失敗就整個還原。
 *  - 遇到沒有 down 的就停下並丟錯,不會跳過它去倒退更早的(順序不能亂)。
 *  - 正式環境預設拒絕,要明確設 ALLOW_MIGRATE_DOWN=1。
 *  - 注意:服務啟動時會再次套用 migrations 陣列裡尚未套用的項目。
 *    所以倒退之後,必須先把程式退回到沒有這個 migration 的版本,否則服務一重啟就又套回去。
 * 回傳實際倒退的 migration id(由後往前)。
 */
export async function migrateDown(pool: Pool, service: string, migrations: Migration[], steps = 1): Promise<string[]> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_MIGRATE_DOWN !== '1') {
    throw new Error('正式環境預設不允許倒退 migration。確定要做時設 ALLOW_MIGRATE_DOWN=1。');
  }
  if (!Number.isInteger(steps) || steps < 1) throw new Error('steps 必須是 >= 1 的整數');

  const client = await pool.connect();
  const done: string[] = [];
  try {
    await client.query(`SELECT set_config('statement_timeout', '0', false)`);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${service}`]);
    const exists = await client.query(`SELECT to_regclass('schema_migrations') AS t`);
    if (!exists.rows[0].t) return done;
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    const targets = migrations.filter((m) => applied.has(m.id)).reverse().slice(0, steps);

    for (const m of targets) {
      if (!m.down) throw new Error(`migration ${m.id} 沒有 down,無法倒退。(已倒退:${done.join(', ') || '無'})`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE id = $1', [m.id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.id} 倒退失敗:${(e as Error).message}(已倒退:${done.join(', ') || '無'})`);
      }
      done.push(m.id);
    }
    return done;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${service}`]);
      await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(envInt('PG_STATEMENT_TIMEOUT_MS', 10_000))]);
    } finally {
      client.release();
    }
  }
}
