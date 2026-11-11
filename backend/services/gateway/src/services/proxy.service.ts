import { clientIp, type Ctx } from '@chat-app/shared/app';
import { internalToken, urls } from '@chat-app/shared/config';
import { AppError } from '@chat-app/shared/errors';
import type { Logger } from '@chat-app/shared/log';
import { Upstream } from '@chat-app/shared/upstream';
import type { Route, Target } from '../route-table';
import type { SessionGuard } from './session-guard';

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

export interface Identity {
  userId: string;
  sid: string;
}

/** 把請求轉給上游服務,回應(含 SSE)以串流方式原樣回傳。 */
export class ProxyService {
  /** 進行中的轉發數(含 SSE 串流)。關閉時要等它歸零,串流才不會被硬切 */
  private inflightCount = 0;
  readonly upstreams: Record<Target, Upstream>;

  constructor(
    private readonly guard: SessionGuard,
    private readonly log: Logger,
  ) {
    this.upstreams = {
      auth: new Upstream('auth', urls.auth(), log),
      character: new Upstream('character', urls.character(), log),
      chat: new Upstream('chat', urls.chat(), log),
      billing: new Upstream('billing', urls.billing(), log),
      booking: new Upstream('booking', urls.booking(), log),
    };
  }

  get inflight(): number {
    return this.inflightCount;
  }

  /** 各服務目前解析到的 replica 數 */
  replicas(): Record<Target, number> {
    return Object.fromEntries(Object.entries(this.upstreams).map(([k, u]) => [k, u.replicas])) as Record<Target, number>;
  }

  /** 關閉時:等進行中的轉發收尾,最多 timeoutMs */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflightCount > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }

  async forward(c: Ctx, route: Route, path: string, identity?: Identity): Promise<Response> {
    const { log, guard } = this;
    const up = this.upstreams[route.target];
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

    this.inflightCount++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.inflightCount--;
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
}
