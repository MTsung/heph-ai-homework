import { buildApp, onShutdown } from '@chat-app/shared/app';
import { ServiceClient } from '@chat-app/shared/client';
import { urls } from '@chat-app/shared/config';
import { createRedis } from '@chat-app/shared/redis';
import { loadConfig } from './config';
import { internalRoutes } from './routes/internal.routes';
import { publicRoutes } from './routes/public.routes';
import { ProxyService } from './services/proxy.service';
import { RateLimiter } from './services/rate-limiter';
import { SessionGuard } from './services/session-guard';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redis = createRedis('gateway');
  const { app, log, listen } = buildApp({
    service: 'gateway',
    internalAuth: false,
    ready: async () => {
      await redis.ping();
    },
  });

  // ---- 組裝
  const guard = new SessionGuard(redis, new ServiceClient('auth', urls.auth(), 2000), log);
  const proxy = new ProxyService(guard, log);
  const limiter = new RateLimiter(redis);

  // ---- 路由
  app.route('/', publicRoutes({ guard, proxy, limiter, limits: cfg.limits }));
  app.route('/', internalRoutes({ guard, proxy }));

  // ---- 啟動與關閉
  const server = listen(cfg.port, cfg.maxBodyBytes);
  log.info({ port: server.port }, 'gateway listening');
  onShutdown(log, async () => {
    // 不再接新連線;進行中的請求與 SSE 串流繼續跑,等它們收尾(chat 自己會在 20 秒內結束生成)
    await server.stop();
    await proxy.drain(cfg.drainMs);
    log.info({ inflight: proxy.inflight }, 'gateway drained');
    redis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
