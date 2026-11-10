import { buildApp, clientIp, onShutdown, type Ctx } from '../../../shared/app';
import { ServiceClient } from '../../../shared/client';
import { envInt, internalToken, urls } from '../../../shared/config';
import { AppError, Errors } from '../../../shared/errors';
import { createRedis, rateLimit } from '../../../shared/redis';
import { SseStream } from '../../../shared/sse';
import { Upstream } from '../../../shared/upstream';
import { SessionGuard } from './session';

type Target = 'auth' | 'character' | 'chat' | 'billing' | 'booking';

interface Route {
  /** 對外路徑前綴(不含 /v1) */
  prefix: string;
  target: Target;
  /** 不需要登入 */
  open?: boolean;
}

// 白名單路由:只有列在這裡的路徑才會被轉發。/internal/* 永遠不會被轉發到外部。
const ROUTES: Route[] = [
  { prefix: '/auth/register', target: 'auth', open: true },
  { prefix: '/auth/login', target: 'auth', open: true },
  { prefix: '/auth/logout', target: 'auth' },
  { prefix: '/me', target: 'auth' },
  { prefix: '/characters', target: 'character' },
  { prefix: '/conversations', target: 'chat' },
  { prefix: '/points', target: 'billing' },
  { prefix: '/bookings', target: 'booking' },
];

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // 以下是 gateway 自己決定的,不信任用戶端帶的
  'x-user-id',
  'x-session-id',
  'x-internal-token',
  'x-forwarded-for',
]);

const SEND_RE = /^\/conversations\/[^/]+\/messages$/;

async function main(): Promise<void> {
  const redis = createRedis('gateway');
  const { app, log, listen } = buildApp({
    service: 'gateway',
    internalAuth: false,
    ready: async () => {
      await redis.ping();
    },
  });

  const upstreams: Record<Target, Upstream> = {
    auth: new Upstream('auth', urls.auth(), log),
    character: new Upstream('character', urls.character(), log),
    chat: new Upstream('chat', urls.chat(), log),
    billing: new Upstream('billing', urls.billing(), log),
    booking: new Upstream('booking', urls.booking(), log),
  };

  const guard = new SessionGuard(redis, new ServiceClient('auth', urls.auth(), 2000), log);

  const limits = {
    authPerIpPerMin: envInt('RL_AUTH_PER_IP_PER_MIN', 30),
    userPerMin: envInt('RL_USER_PER_MIN', 600),
    sendPerMin: envInt('RL_SEND_PER_USER_PER_MIN', 30),
    // 訂位的寫入操作(建立 / 回覆 / 確認…)每次都可能呼叫模型或搜尋,另外限流
    bookingPerMin: envInt('RL_BOOKING_PER_USER_PER_MIN', 30),
  };

  // 進行中的轉發數(含 SSE 串流)。關閉時要等它歸零,串流才不會被硬切
  let inflight = 0;

  async function enforce(key: string, limit: number): Promise<void> {
    const r = await rateLimit(redis, key, limit, 60_000);
    if (!r.allowed) throw Errors.tooMany(r.retryAfterSec);
  }

  /** 把請求轉給上游,回應(含 SSE)以串流方式原樣回傳。 */
  async function proxy(c: Ctx, route: Route, path: string, identity?: { userId: string; sid: string }): Promise<Response> {
    const up = upstreams[route.target];
    const search = new URL(c.req.url).search;
    const headers = new Headers();
    for (const [k, v] of c.req.raw.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    headers.delete('authorization'); // 內部服務不需要、也不該看到使用者的 token
    headers.set('x-internal-token', internalToken());
    headers.set('x-request-id', c.get('reqId'));
    headers.set('x-forwarded-for', clientIp(c));
    if (identity) {
      headers.set('x-user-id', identity.userId);
      headers.set('x-session-id', identity.sid);
    }

    const hasBody = !['GET', 'HEAD'].includes(c.req.method);
    const body = hasBody ? await c.req.arrayBuffer() : undefined;

    inflight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inflight--;
      }
    };

    const ac = new AbortController();
    // 只限制「等上游回應標頭」的時間;標頭回來後(包含 SSE 長連線)不再設總時限
    const headerTimer = setTimeout(() => ac.abort(new Error('upstream header timeout')), 10_000);
    let upstream: Response;
    try {
      // 對該服務的多個 replica 輪流分配;連線失敗或對方正在關閉時換另一個 replica(見 shared/upstream.ts)
      upstream = await up.fetch(`${path}${search}`, {
        method: c.req.method,
        headers,
        body,
        signal: ac.signal,
        redirect: 'manual',
      });
    } catch (e) {
      release();
      log.warn({ target: route.target, err: (e as Error).message }, 'upstream request failed');
      throw new AppError(502, 'BAD_GATEWAY', '服務暫時無法使用,請稍後再試');
    } finally {
      clearTimeout(headerTimer);
    }

    const out = new Headers();
    for (const [k, v] of upstream.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);

    const isSse = (upstream.headers.get('content-type') ?? '').startsWith('text/event-stream');
    if (!isSse || !upstream.body) {
      release();
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // SSE:關閉 Bun 的閒置逾時,登記連線(踢人時可中止),用戶端斷線就中止上游
    c.env.server.timeout(c.req.raw, 0);
    const untrack = identity ? guard.trackProxied(identity.sid, ac) : () => undefined;
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            untrack();
            release();
            ctrl.close();
          } else ctrl.enqueue(value);
        } catch {
          untrack();
          release();
          try {
            ctrl.close();
          } catch {
            /* 已關閉 */
          }
        }
      },
      cancel() {
        // 用戶端斷線:取消上游讀取。chat-service 只會移除這個訂閱者,回覆照常生成完。
        untrack();
        release();
        ac.abort(new Error('client disconnected'));
        reader.cancel().catch(() => undefined);
      },
    });
    return new Response(stream, { status: upstream.status, headers: out });
  }

  // ---------------------------------------------------------------- 事件通道(踢人通知)
  app.get('/v1/events', async (c) => {
    const { userId, sid } = await guard.authenticate(c.req.header('authorization'));
    await enforce(`ev:${userId}`, 30);
    const sse = new SseStream(c, 20_000);
    sse.send('ready', { ok: true });
    guard.watch(sid, sse);
    return sse.response;
  });

  // ---------------------------------------------------------------- 一般 API
  app.all('/v1/*', async (c) => {
    const path = c.req.path.slice(3); // 去掉 /v1
    const route = ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
    if (!route) throw Errors.notFound('路徑不存在');

    if (route.open) {
      await enforce(`ip:${clientIp(c)}:auth`, limits.authPerIpPerMin);
      return proxy(c, route, path);
    }

    const identity = await guard.authenticate(c.req.header('authorization'));
    await enforce(`u:${identity.userId}`, limits.userPerMin);
    if (c.req.method === 'POST' && SEND_RE.test(path)) await enforce(`send:${identity.userId}`, limits.sendPerMin);
    if (route.target === 'booking' && c.req.method !== 'GET') await enforce(`booking:${identity.userId}`, limits.bookingPerMin);
    return proxy(c, route, path, identity);
  });

  // 運維用(需要 internal token):目前 session L1 快取大小、被監看/代理中的連線數、chat replica 數
  app.get('/internal/stats', (c) =>
    c.json({
      ...guard.stats,
      inflight,
      chat_replicas: upstreams.chat.replicas,
      replicas: Object.fromEntries(Object.entries(upstreams).map(([k, u]) => [k, u.replicas])),
    }),
  );

  const server = listen(envInt('PORT', 8080), 262_144);
  log.info({ port: server.port }, 'gateway listening');
  onShutdown(log, async () => {
    // 不再接新連線;進行中的請求與 SSE 串流繼續跑,等它們收尾(chat 自己會在 20 秒內結束生成)
    await server.stop();
    const deadline = Date.now() + envInt('GATEWAY_DRAIN_MS', 22_000);
    while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    log.info({ inflight }, 'gateway drained');
    redis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
