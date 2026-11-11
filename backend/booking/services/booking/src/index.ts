import { buildApp, onShutdown } from '@chat-app/shared/app';
import { ServiceClient } from '@chat-app/shared/client';
import { urls } from '@chat-app/shared/config';
import { createPool, migrate, waitForDb } from '@chat-app/shared/db';
import { createLlm } from '@chat-app/shared/llm';
import { createRedis } from '@chat-app/shared/redis';
import { BillingClient } from './clients/billing.client';
import { loadConfig } from './config';
import { userDeletedConsumer } from './consumers/user-deleted.consumer';
import { migrations } from './db/migrations';
import { Nlu } from './domain/nlu';
import { createChannels } from './integrations/channels';
import { BookingSearch } from './integrations/search';
import { BookingReaperJob } from './jobs/reaper.job';
import { createMetrics, llmHooks } from './metrics';
import { ChargeRepository } from './repositories/charge.repository';
import { bookingRoutes } from './routes/bookings.routes';
import { internalRoutes } from './routes/internal.routes';
import { BookingRunner } from './services/booking-runner';
import { BookingService } from './services/booking.service';
import { ChargeService } from './services/charge.service';
import { ConcurrencyLimiter } from './services/concurrency-limiter';
import { InspectionService } from './services/inspection.service';

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

  // 需求理解:有設定真實模型(LLM_PROVIDERS 不是 mock)才用 LLM;否則、或 LLM 失敗時都用規則解析。
  // 沒有任何 API key 也能跑完整流程。
  const chain = cfg.nluMode === 'llm' ? createLlm(llmHooks(metrics), log) : null;
  const nlu = new Nlu(chain && chain.name !== 'mock' ? chain : null, log, cfg.nluTimeoutMs);
  log.info({ nlu: nlu.mode, chain: chain?.name ?? 'disabled', maxConcurrent: cfg.maxConcurrent }, 'booking nlu ready');

  // ---- 組裝:clients / integrations → services
  const billing = new BillingClient(new ServiceClient('billing', urls.billing(), 5000));
  const agent = new ServiceClient('browser-agent', urls.browserAgent(), 120_000);
  const channels = createChannels(agent);
  const limiter = new ConcurrencyLimiter(redis, 'booking-web', cfg.maxConcurrent, cfg.leaseSec * 1000);
  const chargeRepo = new ChargeRepository(pool);
  const charges = new ChargeService(pool, billing, log, () => metrics.billingFailures.inc());

  const runner = new BookingRunner({ pool, charges, channels, limiter, log, metrics, cfg });
  const bookings = new BookingService({
    pool,
    redis,
    chargeRepo,
    charges,
    nlu,
    search: new BookingSearch(),
    channels,
    limiter,
    runner,
    metrics,
    cfg,
  });
  const inspection = new InspectionService(pool, chargeRepo, limiter, runner, nlu, cfg);

  // ---- 路由
  app.route('/', bookingRoutes({ bookings }));
  app.route('/', internalRoutes({ inspection }));

  // ---- 背景任務與事件
  const reaper = new BookingReaperJob(pool, runner, charges, log, cfg);
  reaper.start();
  const consumer = userDeletedConsumer(redis, bookings, log);
  await consumer.start();

  // ---- 啟動與關閉
  const server = listen(cfg.port);
  log.info({ port: server.port }, 'booking listening');
  onShutdown(
    log,
    async () => {
      reaper.stop();
      await server.stop();
      // 等進行中的訂位送完。來不及的由別的 instance 依 exec_phase 接手(絕不會重複送出無冪等保證的請求)
      await runner.drain(cfg.drainWaitMs);
      await consumer.stop();
      await pool.end();
      redis.disconnect();
    },
    cfg.shutdownTimeoutMs,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
