import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { env } from './config';
import type { Logger } from './log';

/**
 * 兩種 Redis 實例,用途與淘汰策略不同(見 docker-compose.yml):
 *  - state:session / 鎖 / 限流 / 串流續傳 / 事件 Stream。不可被淘汰(noeviction + AOF)。
 *  - cache:可重建的快取。記憶體滿了用 LRU 淘汰,不持久化。
 * 兩者分開,快取吃滿記憶體時才不會把使用者的登入狀態擠掉。
 *
 * 一般指令連線啟用 auto pipelining:同一個 event loop tick 內的指令自動合併成一次網路往返,
 * 高併發時大幅減少往返次數。阻塞型(XREADGROUP BLOCK)與 Pub/Sub 必須用 duplicate() 另開連線。
 */
export type RedisKind = 'state' | 'cache';

export function createRedis(name: string, kind: RedisKind = 'state'): Redis {
  const url =
    kind === 'cache'
      ? env('REDIS_CACHE_URL', env('REDIS_URL', 'redis://localhost:6380'))
      : env('REDIS_URL', 'redis://localhost:6379');
  const r = new Redis(url, {
    connectionName: `${name}-${kind}`,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
  r.on('error', () => {
    /* 連線錯誤由 retryStrategy 重連;各呼叫端自行決定 fail-open 或 fail-closed */
  });
  return r;
}

/** 包裝 Lua script:優先 EVALSHA,伺服器沒有快取時自動退回 EVAL。 */
export class Lua {
  private readonly sha: string;
  constructor(private readonly src: string) {
    this.sha = createHash('sha1').update(src).digest('hex');
  }
  async run(r: Redis, keys: string[], args: (string | number)[] = []): Promise<unknown> {
    try {
      return await r.evalsha(this.sha, keys.length, ...keys, ...args.map(String));
    } catch (e) {
      if (String((e as Error).message).includes('NOSCRIPT')) {
        return r.eval(this.src, keys.length, ...keys, ...args.map(String));
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// 分散式鎖(單一 Redis 節點;SET NX PX + 以 token 比對的釋放/續期)
// ---------------------------------------------------------------------------
const RELEASE = new Lua(`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`);
const EXTEND = new Lua(
  `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
);

export async function acquireLock(r: Redis, key: string, ttlMs: number, token: string = randomUUID()): Promise<string | null> {
  const ok = await r.set(key, token, 'PX', ttlMs, 'NX');
  return ok === 'OK' ? token : null;
}
export async function releaseLock(r: Redis, key: string, token: string): Promise<void> {
  await RELEASE.run(r, [key], [token]);
}
export async function extendLock(r: Redis, key: string, token: string, ttlMs: number): Promise<boolean> {
  return Number(await EXTEND.run(r, [key], [token, ttlMs])) === 1;
}

// ---------------------------------------------------------------------------
// 固定視窗限流:INCR + 第一次才設 PEXPIRE,整段在 Lua 內原子完成
// 取捨:視窗交界最多可能放行 2 倍流量;對「防濫用」用途足夠,且只要 1 次 Redis 往返。
// ---------------------------------------------------------------------------
const RATE = new Lua(`
local c = redis.call('incr', KEYS[1])
if c == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
local ttl = redis.call('pttl', KEYS[1])
return {c, ttl}
`);

export interface RateResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/** Redis 故障時 fail-open(放行):限流是保護機制,不應因它自己壞掉而讓整個服務不可用。 */
export async function rateLimit(r: Redis, key: string, limit: number, windowMs: number): Promise<RateResult> {
  try {
    const [count, ttl] = (await RATE.run(r, [`rl:${key}`], [windowMs])) as [number, number];
    return { allowed: count <= limit, count, retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) };
  } catch {
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

// ---------------------------------------------------------------------------
// 快取命中率統計:先在程序內累加,每 5 秒批次寫入 state Redis(避免每次讀取多一次 Redis 寫入)
// ---------------------------------------------------------------------------
export class CacheStats {
  private counters = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly r: Redis,
    private readonly service: string,
  ) {}

  record(ns: string, kind: 'hit' | 'miss' | 'error' | 'coalesced'): void {
    const f = `${this.service}.${ns}.${kind}`;
    this.counters.set(f, (this.counters.get(f) ?? 0) + 1);
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), 5000);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.counters.size === 0) return;
    const snapshot = [...this.counters.entries()];
    this.counters.clear();
    try {
      const p = this.r.pipeline();
      for (const [f, n] of snapshot) p.hincrby('metrics:cache', f, n);
      await p.exec();
    } catch {
      /* 統計遺失可接受 */
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------
// Cache-Aside:讀快取 → 未命中則載入 → 回填
//  - 穿透:不存在的資料也快取一小段時間(null sentinel)
//  - 擊穿:熱 key 過期時,只讓一個請求回源(鎖),其餘短暫等待後讀快取
//  - 雪崩:TTL 加 ±10% 隨機抖動
//  - Redis 故障:fail-open,直接回源(服務降級但仍可用)
// ---------------------------------------------------------------------------
const NULL_SENTINEL = '\u0000null';

export class CacheAside {
  constructor(
    private readonly r: Redis,
    private readonly ns: string,
    private readonly stats: CacheStats,
    private readonly log: Logger,
  ) {}

  async get<T>(key: string, ttlSec: number, loader: () => Promise<T | null>, nullTtlSec = 30): Promise<T | null> {
    const fullKey = `${this.ns}:${key}`;
    try {
      const cached = await this.r.get(fullKey);
      if (cached !== null) {
        this.stats.record(this.ns, 'hit');
        return cached === NULL_SENTINEL ? null : (JSON.parse(cached) as T);
      }
    } catch (e) {
      this.stats.record(this.ns, 'error');
      this.log.warn({ err: (e as Error).message, key: fullKey }, 'cache read failed, fallback to source');
      return loader();
    }

    this.stats.record(this.ns, 'miss');
    const lockKey = `lock:load:${fullKey}`;
    let token: string | null = null;
    try {
      token = await acquireLock(this.r, lockKey, 5000);
      if (!token) {
        // 有人正在回源:最多等 1 秒,期間輪詢快取
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 50));
          const again = await this.r.get(fullKey);
          if (again !== null) {
            this.stats.record(this.ns, 'coalesced');
            return again === NULL_SENTINEL ? null : (JSON.parse(again) as T);
          }
        }
      }
    } catch {
      /* 鎖失敗就直接回源 */
    }

    try {
      const value = await loader();
      try {
        const ttl = value === null ? nullTtlSec : Math.round(ttlSec * (0.9 + Math.random() * 0.2));
        await this.r.set(fullKey, value === null ? NULL_SENTINEL : JSON.stringify(value), 'EX', ttl);
      } catch {
        /* 回填失敗不影響結果 */
      }
      return value;
    } finally {
      if (token) await releaseLock(this.r, lockKey, token).catch(() => undefined);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.r.del(...keys.map((k) => `${this.ns}:${k}`));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'cache delete failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Pub/Sub:訂閱要用獨立連線
// ---------------------------------------------------------------------------
export function subscribe(base: Redis, channel: string, handler: (msg: string) => void): Redis {
  const sub = base.duplicate();
  sub.on('error', () => undefined);
  void sub.subscribe(channel);
  sub.on('message', (ch, msg) => {
    if (ch === channel) handler(msg);
  });
  return sub;
}
