import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import client from 'prom-client';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { AppError, Errors } from './errors';
import { createLogger, type Logger } from './log';
import { envBool, envInt, internalToken } from './config';

export type BunServer = ReturnType<typeof Bun.serve>;

export interface AppEnv {
  Bindings: { server: BunServer };
  Variables: { reqId: string };
}
export type Ctx = Context<AppEnv>;

/** 建立一組路由(各服務的 routes/*.routes.ts 使用),再由 index.ts 以 app.route('/', router) 掛上。 */
export function createRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}

export interface AppOptions {
  service: string;
  /** false = 對外服務(gateway / admin):業務路由不檢查 x-internal-token;其餘服務一律檢查 */
  internalAuth?: boolean;
  /** 就緒檢查(DB / Redis 連得上才算 ready) */
  ready?: () => Promise<void>;
}

export interface BuiltApp {
  app: Hono<AppEnv>;
  log: Logger;
  registry: client.Registry;
  /** 啟動 HTTP server。maxBodyBytes 預設 1MB(Bun 預設 128MB,太大)。 */
  listen: (port: number, maxBodyBytes?: number) => BunServer;
}

const OPEN_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function buildApp(opts: AppOptions): BuiltApp {
  const log = createLogger(opts.service);
  const app = new Hono<AppEnv>();

  // --- Prometheus 指標 ---
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: opts.service });
  client.collectDefaultMetrics({ register: registry });
  const httpHist = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP 請求耗時(SSE 串流只計算到回應開始)',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const logAll = envBool('LOG_REQUESTS', false);
  const slowMs = envInt('SLOW_REQUEST_MS', 1000);

  app.use('*', async (c, next) => {
    const start = performance.now();
    const reqId = c.req.header('x-request-id') || crypto.randomUUID();
    c.set('reqId', reqId);
    c.header('x-request-id', reqId);
    const path = c.req.path;
    // 內部服務:除了探活端點,一律要 internal token。
    // 對外服務(gateway / admin):業務路由不檢查,但 /metrics、/readyz、/internal-* 等運維端點仍要 token。
    const external = opts.internalAuth === false;
    const needsToken = external
      ? path === '/metrics' || path === '/readyz' || path.startsWith('/internal')
      : !OPEN_PATHS.has(path);
    if (needsToken) {
      const t = c.req.header('x-internal-token');
      if (!t || !safeEqual(t, internalToken())) {
        throw new AppError(401, 'UNAUTHORIZED', 'internal token invalid');
      }
    }
    await next();
    const ms = performance.now() - start;
    const status = c.res.status;
    const route = c.req.routePath;
    httpHist.labels(c.req.method, route, String(status)).observe(ms / 1000);
    // 高併發下逐筆 access log 成本高:只記錄慢請求與 5xx(LOG_REQUESTS=1 可全開)
    if (logAll || status >= 500 || ms > slowMs) {
      log.info({ reqId, method: c.req.method, route, status, ms: Math.round(ms) }, 'request');
    }
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      // 這個 replica 正在關閉、請求還沒被處理:標頭讓呼叫端(gateway / ServiceClient)直接換另一個 replica 重送
      if (err.code === 'SERVER_DRAINING') c.header('x-draining', '1');
      if (err.status >= 500) log.error({ reqId: c.get('reqId'), err: err.message, code: err.code }, 'request failed');
      return c.json(err.toBody(), err.status as ContentfulStatusCode);
    }
    if (err instanceof ZodError) {
      return c.json(Errors.badRequest(err.issues[0]?.message ?? '參數錯誤').toBody(), 400);
    }
    log.error({ reqId: c.get('reqId'), err: err.message, stack: err.stack }, 'unhandled error');
    return c.json({ error: { code: 'INTERNAL', message: '伺服器發生錯誤' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: '路徑不存在' } }, 404));

  app.get('/healthz', (c) => c.json({ status: 'ok', service: opts.service }));
  app.get('/readyz', async (c) => {
    if (shuttingDown) return c.json({ status: 'draining', service: opts.service }, 503);
    try {
      await opts.ready?.();
      return c.json({ status: 'ready', service: opts.service });
    } catch (e) {
      return c.json({ status: 'not_ready', reason: (e as Error).message }, 503);
    }
  });
  app.get('/metrics', async (c) => {
    return c.body(await registry.metrics(), 200, { 'content-type': registry.contentType });
  });

  const listen = (port: number, maxBodyBytes = 1_048_576) =>
    Bun.serve({
      port,
      hostname: '0.0.0.0',
      // 一般請求 30 秒沒動靜就斷線;SSE 串流會另外對單一請求呼叫 server.timeout(req, 0) 關閉此逾時
      idleTimeout: 30,
      maxRequestBodySize: maxBodyBytes,
      fetch: (req, server) => app.fetch(req, { server }),
    });

  return { app, log, registry, listen };
}

/** 讀 JSON body。空 body 視為 {};格式錯誤回 400。 */
export async function readJson(c: Ctx): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Errors.badRequest('請求內容不是合法的 JSON');
  }
}

/** 讀取 gateway 驗證後注入的使用者身分(服務只信任帶有正確 internal token 的請求)。 */
export function requireUser(c: Ctx): { userId: string; sessionId: string } {
  const userId = c.req.header('x-user-id');
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw Errors.unauthenticated();
  return { userId, sessionId: c.req.header('x-session-id') ?? '' };
}

export function clientIp(c: Ctx): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.env.server.requestIP(c.req.raw)?.address ?? 'unknown';
}

/** 收到 SIGTERM 之後為 true;/readyz 會回 503,讓負載平衡器 / 編排系統不再把新請求送過來 */
let shuttingDown = false;

/** 優雅關閉:收到 SIGTERM 時先執行清理(停止接新請求、等串流收尾),再結束。 */
export function onShutdown(log: Logger, cleanup: () => Promise<void>, timeoutMs = 25_000): void {
  const handler = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ sig }, 'shutting down');
    const force = setTimeout(() => {
      log.warn('shutdown timeout, forcing exit');
      process.exit(1);
    }, timeoutMs);
    force.unref();
    cleanup()
      .catch((e) => log.error({ err: (e as Error).message }, 'cleanup failed'))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
