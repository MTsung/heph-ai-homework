import { buildApp, onShutdown } from '@chat-app/shared/app';
import { createPool, migrate, waitForDb } from '@chat-app/shared/db';
import { CacheAside, CacheStats, createRedis } from '@chat-app/shared/redis';
import { loadConfig } from './config';
import { userDeletedConsumer } from './consumers/user-deleted.consumer';
import { migrations } from './db/migrations';
import { HoldSweeperJob } from './jobs/hold-sweeper.job';
import { internalRoutes } from './routes/internal.routes';
import { pointsRoutes } from './routes/points.routes';
import { AccountService } from './services/account.service';
import { HoldService } from './services/hold.service';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool('billing');
  const redis = createRedis('billing'); // state:事件 Stream、統計
  const cacheRedis = createRedis('billing', 'cache'); // cache:餘額顯示用快取
  const { app, log, listen } = buildApp({
    service: 'billing',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
      await cacheRedis.ping();
    },
  });
  const stats = new CacheStats(redis, 'billing');
  stats.start();

  await waitForDb(pool);
  await migrate(pool, 'billing', migrations);

  // ---- 組裝
  const accounts = new AccountService(pool, new CacheAside(cacheRedis, 'bal', stats, log), cfg);
  const holds = new HoldService(pool, accounts, cfg);

  // ---- 背景任務與事件
  const sweeper = new HoldSweeperJob(holds, log, cfg.sweepIntervalMs);
  sweeper.start();
  const consumer = userDeletedConsumer(redis, accounts, log);
  await consumer.start();

  // ---- 路由
  app.route('/', pointsRoutes({ accounts }));
  app.route('/', internalRoutes({ accounts, holds }));

  // ---- 啟動與關閉
  const server = listen(cfg.port);
  log.info({ port: server.port }, 'billing listening');
  onShutdown(log, async () => {
    sweeper.stop();
    await consumer.stop();
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
