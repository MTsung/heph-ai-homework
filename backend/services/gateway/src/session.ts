import type Redis from 'ioredis';
import type { ServiceClient } from '../../../shared/client';
import { channels, keys } from '../../../shared/config';
import { AppError, Errors } from '../../../shared/errors';
import type { Logger } from '../../../shared/log';
import { subscribe } from '../../../shared/redis';
import { verifyToken } from '../../../shared/jwt';
import { tokenTtlSeconds } from '../../../shared/jwt';
import type { SseStream } from '../../../shared/sse';

/**
 * 單一裝置的驗證與「踢人」。
 *
 * 驗證一個請求的成本(由便宜到昂貴,逐層回源):
 *   L1 行程內 Map(TTL 5 秒)  →  Redis sess:{uid}  →  auth-service(查 DB,真相來源)
 * 99% 以上的請求在 L1 就結束,不產生任何網路往返。
 *
 * 踢人的即時性:
 *   auth 在新裝置登入時 PUBLISH evt:session → 每台 gateway 收到後
 *     1. 立刻清掉該使用者的 L1 → 舊 token 下一個請求就會被拒絕(SESSION_REPLACED)
 *     2. 切斷舊 sid 上還開著的 SSE 連線,並通知舊裝置的 /v1/events
 *   若 Pub/Sub 訊息遺失,最壞情況舊裝置還能用 L1 TTL(5 秒)。
 */
export interface SessionEvent {
  /** replaced = 新裝置取代舊裝置;revoked = 登出/強制登出/刪帳號;started = 首次登入(沒有舊 session) */
  type: 'replaced' | 'revoked' | 'started';
  user_id: string;
  old_sid: string;
  new_sid?: string;
  new_device_name?: string;
}

export class SessionGuard {
  private l1 = new Map<string, { sid: string | null; exp: number }>();
  /** sid → 該 session 上開著的 SSE(/v1/events) */
  private listeners = new Map<string, Set<SseStream>>();
  /** sid → 該 session 上被代理中的上游請求,踢人時一併中止 */
  private proxied = new Map<string, Set<AbortController>>();

  constructor(
    private readonly redis: Redis,
    private readonly auth: ServiceClient,
    private readonly log: Logger,
    private readonly l1TtlMs = 5000,
  ) {
    subscribe(redis, channels.sessionEvents, (raw) => {
      try {
        this.onEvent(JSON.parse(raw) as SessionEvent);
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'bad session event');
      }
    });
  }

  private onEvent(ev: SessionEvent): void {
    this.l1.delete(ev.user_id);
    if (!ev.old_sid) return; // started:沒有舊 session,清完本機快取就好
    for (const ac of this.proxied.get(ev.old_sid) ?? []) ac.abort(new Error('session replaced'));
    this.proxied.delete(ev.old_sid);
    const set = this.listeners.get(ev.old_sid);
    if (set) {
      for (const s of set) {
        s.send('session_replaced', {
          reason: ev.type,
          device_name: ev.new_device_name ?? null,
          message: ev.type === 'replaced' ? '你的帳號已在其他裝置登入' : '登入已失效',
        });
        s.end();
      }
      this.listeners.delete(ev.old_sid);
    }
  }

  /** 驗證 Authorization header。回傳使用者與 session;失敗丟 401(含 SESSION_REPLACED 區分)。 */
  async authenticate(authorization: string | undefined): Promise<{ userId: string; sid: string }> {
    const m = /^Bearer (.+)$/i.exec(authorization ?? '');
    if (!m) throw Errors.unauthenticated();
    const claims = verifyToken(m[1]!); // 簽章、效期;純 CPU,不碰網路
    const active = await this.activeSid(claims.sub);
    if (active === claims.sid) return { userId: claims.sub, sid: claims.sid };
    if (active === null) throw new AppError(401, 'SESSION_EXPIRED', '登入已失效,請重新登入');
    throw new AppError(401, 'SESSION_REPLACED', '你的帳號已在其他裝置登入');
  }

  private async activeSid(userId: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.l1.get(userId);
    if (hit && hit.exp > now) return hit.sid;

    let sid: string | null = null;
    let fromRedis = false;
    try {
      sid = await this.redis.get(keys.session(userId));
      fromRedis = true;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'session redis read failed, falling back to auth');
    }
    if (sid === null) {
      try {
        const r = await this.auth.get<{ sid: string }>(`/internal/sessions/${userId}`);
        sid = r.sid;
        if (fromRedis) {
          // NX:只在 key 不存在時回填,不會蓋掉剛好同時登入寫入的新 sid
          await this.redis.set(keys.session(userId), sid, 'EX', tokenTtlSeconds(), 'NX').catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof AppError && e.status === 404) {
          sid = null;
        } else {
          throw e; // auth 掛了且 Redis 也沒有 → 無法確認身分,fail closed
        }
      }
    }
    this.l1.set(userId, { sid, exp: now + (sid ? this.l1TtlMs : 1500) });
    if (this.l1.size > 100_000) this.l1.clear();
    return sid;
  }

  // ---- /v1/events 與被代理的連線登記 ----
  watch(sid: string, sse: SseStream): void {
    let set = this.listeners.get(sid);
    if (!set) this.listeners.set(sid, (set = new Set()));
    set.add(sse);
    sse.onClose(() => {
      set!.delete(sse);
      if (set!.size === 0) this.listeners.delete(sid);
    });
  }

  trackProxied(sid: string, ac: AbortController): () => void {
    let set = this.proxied.get(sid);
    if (!set) this.proxied.set(sid, (set = new Set()));
    set.add(ac);
    return () => {
      set!.delete(ac);
      if (set!.size === 0) this.proxied.delete(sid);
    };
  }

  get stats(): { watchers: number; proxied: number; l1: number } {
    let w = 0;
    let p = 0;
    for (const s of this.listeners.values()) w += s.size;
    for (const s of this.proxied.values()) p += s.size;
    return { watchers: w, proxied: p, l1: this.l1.size };
  }
}
