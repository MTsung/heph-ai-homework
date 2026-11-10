import { hostname } from 'node:os';
import { z } from 'zod';
import client from 'prom-client';
import { buildApp, onShutdown, readJson, requireUser, type Ctx } from '../../../../shared/app';
import { ServiceClient } from '../../../../shared/client';
import { env, envInt, streams, urls } from '../../../../shared/config';
import { createPool, migrate, waitForDb } from '../../../../shared/db';
import { AppError, Errors, parse } from '../../../../shared/errors';
import { StreamConsumer } from '../../../../shared/events';
import { ConcurrencyLimiter } from './limiter';
import { createLlm } from '../../../../shared/llm';
import { createRedis } from '../../../../shared/redis';
import { Charges } from './charges';
import { createChannels } from './channels';
import { createMetrics, loadConfig, type Deps } from './deps';
import { migrations } from './migrations';
import { Nlu } from './nlu';
import { BookingReaper } from './reaper';
import { Runner } from './runner';
import { BookingSearch } from './search';
import { BookingService, HISTORY_RESULTS, LIST_VIEWS, confirmBody, createBody, decodeCursor, messageBody, slotsBody, toView } from './service';
import type { BookingRow } from './types';

const uuid = z.string().uuid();

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool('booking');
  const redis = createRedis('booking');
  const { app, log, registry, listen } = buildApp({
    service: 'booking',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  });

  await waitForDb(pool);
  await migrate(pool, 'booking', migrations);

  const metrics = createMetrics(registry);
  const llmAttempts = new client.Counter({
    name: 'booking_llm_attempts_total',
    help: '對各模型供應商的嘗試結果',
    labelNames: ['provider', 'outcome'],
    registers: [registry],
  });

  // 需求理解:有設定真實模型(LLM_PROVIDERS 不是 mock)才用 LLM;否則、或 LLM 失敗時都用規則解析。
  // 沒有任何 API key 也能跑完整流程。
  const chain = env('BOOKING_NLU', 'llm') === 'llm' ? createLlm({ attempt: (p, o) => llmAttempts.labels(p, o).inc(), failover: () => undefined, breaker: () => undefined }, log) : null;
  const nlu = new Nlu(chain && chain.name !== 'mock' ? chain : null, log, envInt('NLU_TIMEOUT_MS', 8000));
  log.info({ nlu: nlu.mode, chain: chain?.name ?? 'disabled', maxConcurrent: cfg.maxConcurrent }, 'booking nlu ready');

  const billing = new ServiceClient('billing', urls.billing(), 5000);
  const agent = new ServiceClient('browser-agent', urls.browserAgent(), 120_000);
  const d: Deps = {
    pool,
    redis,
    billing,
    agent,
    search: new BookingSearch(),
    channels: createChannels(agent),
    nlu,
    limiter: new ConcurrencyLimiter(redis, 'booking-web', cfg.maxConcurrent, cfg.leaseSec * 1000),
    charges: new Charges(pool, billing, log, () => metrics.billingFailures.inc()),
    log,
    metrics,
    cfg,
  };
  const runner = new Runner(d);
  const svc = new BookingService(d, runner);
  const reaper = new BookingReaper(d, runner);
  reaper.start();

  // ======================================================================= 對外 API(經 gateway,已帶 x-user-id)
  /** 繁忙時多回一個標準的 Retry-After 標頭 */
  const withRetryAfter = async <T>(c: Ctx, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AppError && typeof e.extra?.retry_after === 'number') c.header('retry-after', String(e.extra.retry_after));
      throw e;
    }
  };

  // 免費的需求判斷(純規則)。一般聊天不會因為這個多花點數
  app.post('/bookings/detect', async (c) => {
    requireUser(c);
    const b = parse(z.object({ text: z.string().max(500) }), await readJson(c));
    return c.json(svc.detect(b.text));
  });

  app.post('/bookings', async (c) => {
    const { userId } = requireUser(c);
    const r = await svc.create(userId, parse(createBody, await readJson(c)));
    return c.json(r.view, r.created ? 201 : 200);
  });

  app.get('/bookings', async (c) => {
    const { userId } = requireUser(c);
    const q = parse(
      z.object({
        view: z.enum(LIST_VIEWS).optional(),
        // 舊參數(相容):status=active|all
        status: z.enum(['active', 'all']).optional(),
        result: z.enum(HISTORY_RESULTS).optional(),
        include_drafts: z.enum(['true', 'false']).default('false'),
        before: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      c.req.query(),
    );
    const before = q.before ? decodeCursor(q.before) : undefined;
    if (before === null) throw Errors.badRequest('before 游標無效');
    return c.json(
      await svc.list(userId, {
        view: q.view ?? q.status ?? 'all',
        limit: q.limit,
        result: q.result,
        includeDrafts: q.include_drafts === 'true',
        before,
      }),
    );
  });

  app.get('/bookings/:id', async (c) => c.json(await svc.get(requireUser(c).userId, parse(uuid, c.req.param('id')))));

  app.post('/bookings/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await svc.message(userId, parse(uuid, c.req.param('id')), parse(messageBody, await readJson(c))));
  });

  app.patch('/bookings/:id/slots', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await svc.setSlots(userId, parse(uuid, c.req.param('id')), parse(slotsBody, await readJson(c))));
  });

  app.post('/bookings/:id/confirm', async (c) => {
    const { userId } = requireUser(c);
    const id = parse(uuid, c.req.param('id'));
    const b = parse(confirmBody, await readJson(c));
    return c.json(await withRetryAfter(c, () => svc.confirm(userId, id, b.plan_hash)), 202);
  });

  app.post('/bookings/:id/cancel', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await svc.cancel(userId, parse(uuid, c.req.param('id'))));
  });

  // ======================================================================= 內部 API(admin / 客服)
  app.get('/internal/bookings', async (c) => {
    const q = parse(z.object({ user_id: uuid, limit: z.coerce.number().int().min(1).max(100).default(30) }), c.req.query());
    const { rows } = await pool.query<BookingRow>('SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [q.user_id, q.limit]);
    return c.json({ items: rows.map((r) => ({ ...toView(d, r), user_id: r.user_id })) });
  });

  app.get('/internal/bookings/:id', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const { rows } = await pool.query<BookingRow>('SELECT * FROM bookings WHERE id = $1', [id]);
    if (!rows[0]) throw Errors.notFound('找不到訂位需求');
    const [events, charges] = await Promise.all([
      pool.query('SELECT id, type, text, data, created_at FROM booking_events WHERE booking_id = $1 ORDER BY id', [id]),
      pool.query('SELECT ref, kind, amount, state, note, created_at, updated_at FROM charges WHERE booking_id = $1 ORDER BY created_at', [id]),
    ]);
    return c.json({ ...toView(d, rows[0], { events: events.rows, charges: charges.rows }), user_id: rows[0].user_id, exec: { phase: rows[0].exec_phase, attempt: rows[0].attempt } });
  });

  app.get('/internal/stats', async (c) => {
    const [byStatus, charges] = await Promise.all([
      pool.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM bookings GROUP BY status'),
      pool.query<{ state: string; n: string }>('SELECT state, count(*) AS n FROM charges GROUP BY state'),
    ]);
    return c.json({
      bookings: Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.n)])),
      charges: Object.fromEntries(charges.rows.map((r) => [r.state, Number(r.n)])),
      executing_slots: { in_use: await d.limiter.inUse().catch(() => null), max: cfg.maxConcurrent },
      running_this_instance: runner.active,
      nlu: nlu.mode,
    });
  });

  // ======================================================================= 刪除帳號(冪等)
  const consumer = new StreamConsumer(
    redis,
    streams.userEvents,
    'booking',
    `booking-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      const r = await pool.query('DELETE FROM bookings WHERE user_id = $1', [userId]); // 對話、扣點紀錄隨 ON DELETE CASCADE 一併刪除
      log.info({ userId, bookings: r.rowCount }, 'booking data deleted for user');
    },
    log,
  );
  await consumer.start();

  const server = listen(envInt('PORT', 3005));
  log.info({ port: server.port }, 'booking listening');
  onShutdown(
    log,
    async () => {
      reaper.stop();
      await server.stop();
      // 等進行中的訂位送完。來不及的由別的 instance 依 exec_phase 接手(絕不會重複送出無冪等保證的請求)
      await runner.drain(envInt('DRAIN_WAIT_MS', 20_000));
      await consumer.stop();
      await pool.end();
      redis.disconnect();
    },
    envInt('SHUTDOWN_TIMEOUT_MS', 28_000),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
