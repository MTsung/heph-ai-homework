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
  sql: string;
}

/**
 * 極簡 migration:依序執行尚未套用的 SQL,記錄在 schema_migrations。
 * 用 advisory lock 避免多個 replica 同時啟動時重複執行。
 */
export async function migrate(pool: Pool, service: string, migrations: Migration[]): Promise<void> {
  const client = await pool.connect();
  try {
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
    } finally {
      client.release();
    }
  }
}
