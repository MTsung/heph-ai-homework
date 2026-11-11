import { buildApp, onShutdown } from '@chat-app/shared/app';
import { envInt } from '@chat-app/shared/config';
import { createPool, migrate, waitForDb } from '@chat-app/shared/db';
import { OutboxRelay } from '@chat-app/shared/events';
import { createRedis } from '@chat-app/shared/redis';
import { migrations } from './db/migrations';
import { authRoutes } from './routes/auth.routes';
import { internalRoutes } from './routes/internal.routes';
import { AuthService } from './services/auth.service';
import { SessionService } from './services/session.service';

async function main(): Promise<void> {
  const pool = createPool('auth');
  const redis = createRedis('auth');
  const { app, log, listen } = buildApp({
    service: 'auth',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  });

  await waitForDb(pool);
  await migrate(pool, 'auth', migrations);

  // ---- 組裝
  const sessions = new SessionService(pool, redis);
  const auth = new AuthService(pool, sessions);
  // outbox → Redis Stream(user.deleted 等事件)
  const relay = new OutboxRelay(pool, redis, log);
  relay.start();

  // ---- 路由
  app.route('/', authRoutes({ auth }));
  app.route('/', internalRoutes({ auth, sessions }));

  // ---- 啟動與關閉
  const server = listen(envInt('PORT', 3001));
  log.info({ port: server.port }, 'auth listening');
  onShutdown(log, async () => {
    relay.stop();
    await server.stop();
    await pool.end();
    redis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
