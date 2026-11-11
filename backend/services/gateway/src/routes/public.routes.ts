import { clientIp, createRouter } from '@chat-app/shared/app';
import { Errors } from '@chat-app/shared/errors';
import { SseStream } from '@chat-app/shared/sse';
import type { GatewayConfig } from '../config';
import { findRoute, isSendMessage } from '../route-table';
import type { ProxyService } from '../services/proxy.service';
import type { RateLimiter } from '../services/rate-limiter';
import type { SessionGuard } from '../services/session-guard';

interface Deps {
  guard: SessionGuard;
  proxy: ProxyService;
  limiter: RateLimiter;
  limits: GatewayConfig['limits'];
}

/** 對外 API:/v1/events(踢人通知)與 /v1/*(驗證、限流後轉發) */
export function publicRoutes({ guard, proxy, limiter, limits }: Deps) {
  const r = createRouter();

  // ---------------------------------------------------------------- 事件通道(踢人通知)
  r.get('/v1/events', async (c) => {
    const { userId, sid } = await guard.authenticate(c.req.header('authorization'));
    await limiter.enforce(`ev:${userId}`, limits.eventsPerMin);
    const sse = new SseStream(c, 20_000);
    sse.send('ready', { ok: true });
    guard.watch(sid, sse);
    return sse.response;
  });

  // ---------------------------------------------------------------- 一般 API
  r.all('/v1/*', async (c) => {
    const path = c.req.path.slice(3); // 去掉 /v1
    const route = findRoute(path);
    if (!route) throw Errors.notFound('路徑不存在');

    if (route.open) {
      await limiter.enforce(`ip:${clientIp(c)}:auth`, limits.authPerIpPerMin);
      return proxy.forward(c, route, path);
    }

    const identity = await guard.authenticate(c.req.header('authorization'));
    await limiter.enforce(`u:${identity.userId}`, limits.userPerMin);
    if (isSendMessage(c.req.method, path)) await limiter.enforce(`send:${identity.userId}`, limits.sendPerMin);
    if (route.target === 'booking' && c.req.method !== 'GET') await limiter.enforce(`booking:${identity.userId}`, limits.bookingPerMin);
    return proxy.forward(c, route, path, identity);
  });

  return r;
}
