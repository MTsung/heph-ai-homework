import { createRouter } from '@chat-app/shared/app';
import type { ProxyService } from '../services/proxy.service';
import type { SessionGuard } from '../services/session-guard';

/** 運維用(需要 internal token):session L1 快取大小、被監看/代理中的連線數、各服務 replica 數 */
export function internalRoutes({ guard, proxy }: { guard: SessionGuard; proxy: ProxyService }) {
  const r = createRouter();

  r.get('/internal/stats', (c) => {
    const replicas = proxy.replicas();
    return c.json({
      ...guard.stats,
      inflight: proxy.inflight,
      chat_replicas: replicas.chat,
      replicas,
    });
  });

  return r;
}
