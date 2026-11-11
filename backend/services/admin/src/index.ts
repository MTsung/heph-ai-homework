import { buildApp, onShutdown } from '@chat-app/shared/app';
import { createRedis } from '@chat-app/shared/redis';
import { createClients } from './clients';
import { loadConfig } from './config';
import { apiRoutes } from './routes/api.routes';
import { pageRoutes } from './routes/page.routes';
import { BrowserTraceService } from './services/browser-trace.service';
import { OverviewService } from './services/overview.service';
import { SupportService } from './services/support.service';

/**
 * 後台(依需求:簡單網頁、不做權限)。
 * 安全注意:這個服務沒有任何登入驗證,compose 只把它綁在 127.0.0.1;
 * 它也能讀取對話內容與調整點數,上線前必須加上身分驗證(SSO/RBAC)與操作稽核紀錄。
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const redis = createRedis('admin');
  const cacheRedis = createRedis('admin', 'cache');
  const clients = createClients();

  const { app, log, listen } = buildApp({
    service: 'admin',
    internalAuth: false, // 後台是給人用的:/api 與頁面不檢查 internal token
    ready: async () => {
      await redis.ping();
    },
  });

  // ---- 組裝
  const overview = new OverviewService(clients, redis, cacheRedis);
  const support = new SupportService(clients);
  const traces = new BrowserTraceService(clients, cfg.artifactRoot);

  // ---- 路由
  app.route('/', pageRoutes({ pagePath: cfg.pagePath }));
  app.route('/', apiRoutes({ overview, support, traces }));

  // ---- 啟動與關閉
  const server = listen(cfg.port);
  log.info({ port: server.port }, 'admin listening');
  onShutdown(log, async () => {
    await server.stop();
    redis.disconnect();
    cacheRedis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
