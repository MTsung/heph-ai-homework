import type { Pool, PoolClient } from 'pg';
import type Redis from 'ioredis';
import type { Logger } from './log';

/**
 * Transactional Outbox:
 * 業務資料與「要發出的事件」在同一個 DB transaction 寫入,由 relay 轉送到 Redis Stream。
 * 避免「DB 已提交、事件卻沒發出去」(例如刪除帳號後,對話資料沒被清掉)。
 */
export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  stream text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
`;

export async function enqueueEvent(
  client: PoolClient | Pool,
  stream: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query('INSERT INTO outbox (stream, type, payload) VALUES ($1, $2, $3)', [stream, type, payload]);
}

export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const n = await this.publishBatch();
        if (n < 100) break;
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'outbox relay failed, will retry');
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; stream: string; type: string; payload: unknown }>(
        `SELECT id, stream, type, payload FROM outbox
          WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows) {
        // 至少一次投遞:XADD 成功但 UPDATE 失敗會重送,consumer 必須是冪等的
        await this.redis.xadd(
          row.stream,
          'MAXLEN',
          '~',
          '100000',
          '*',
          'type',
          row.type,
          'outbox_id',
          String(row.id),
          'payload',
          JSON.stringify(row.payload),
        );
      }
      if (rows.length > 0) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
          rows.map((r) => r.id),
        ]);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export interface StreamEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Redis Stream consumer group:
 *  - handler 成功才 XACK;失敗或程序中途掛掉,訊息會留在 pending,稍後被自己或其他 consumer 認領重試
 *  - 因此 handler 必須冪等
 */
export class StreamConsumer {
  private stopped = false;
  private readonly blocking: Redis;

  constructor(
    redis: Redis,
    private readonly stream: string,
    private readonly group: string,
    private readonly consumer: string,
    private readonly handler: (e: StreamEvent) => Promise<void>,
    private readonly log: Logger,
  ) {
    this.blocking = redis.duplicate(); // 阻塞讀取要獨立連線
    this.blocking.on('error', () => undefined);
  }

  async start(): Promise<void> {
    try {
      await this.blocking.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM');
    } catch (e) {
      if (!String((e as Error).message).includes('BUSYGROUP')) throw e;
    }
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.blocking.disconnect();
  }

  private parse(fields: string[]): StreamEvent | null {
    const m: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) m[fields[i]!] = fields[i + 1]!;
    try {
      return { id: '', type: m.type ?? '', payload: JSON.parse(m.payload ?? '{}') };
    } catch {
      return null;
    }
  }

  private async handle(id: string, fields: string[]): Promise<void> {
    const ev = this.parse(fields);
    if (ev) {
      ev.id = id;
      await this.handler(ev);
    }
    await this.blocking.xack(this.stream, this.group, id);
  }

  private async loop(): Promise<void> {
    let lastClaim = 0;
    while (!this.stopped) {
      try {
        // 每 30 秒認領別人(或自己上次)處理到一半就掛掉的訊息
        if (Date.now() - lastClaim > 30_000) {
          lastClaim = Date.now();
          const claimed = (await this.blocking.xautoclaim(
            this.stream,
            this.group,
            this.consumer,
            60_000,
            '0-0',
            'COUNT',
            20,
          )) as [string, [string, string[]][]];
          for (const [id, fields] of claimed[1] ?? []) await this.safeHandle(id, fields);
        }
        const res = (await this.blocking.xreadgroup(
          'GROUP',
          this.group,
          this.consumer,
          'COUNT',
          10,
          'BLOCK',
          5000,
          'STREAMS',
          this.stream,
          '>',
        )) as [string, [string, string[]][]][] | null;
        if (!res) continue;
        for (const [, entries] of res) for (const [id, fields] of entries) await this.safeHandle(id, fields);
      } catch (e) {
        if (this.stopped) return;
        this.log.warn({ err: (e as Error).message, stream: this.stream }, 'stream consumer error, retrying');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async safeHandle(id: string, fields: string[]): Promise<void> {
    try {
      await this.handle(id, fields);
    } catch (e) {
      this.log.error({ err: (e as Error).message, id, stream: this.stream }, 'event handler failed; left pending for retry');
    }
  }
}
