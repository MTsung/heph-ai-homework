import type Redis from 'ioredis';
import type { Clients } from '../clients';

function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function redisSummary(r: Redis) {
  const info = parseInfo(await r.info());
  const hits = Number(info.keyspace_hits ?? 0);
  const misses = Number(info.keyspace_misses ?? 0);
  return {
    used_memory: info.used_memory_human,
    maxmemory_policy: info.maxmemory_policy,
    connected_clients: Number(info.connected_clients ?? 0),
    ops_per_sec: Number(info.instantaneous_ops_per_sec ?? 0),
    evicted_keys: Number(info.evicted_keys ?? 0),
    keyspace_hit_rate: hits + misses > 0 ? hits / (hits + misses) : null,
  };
}

/** 總覽:各服務的統計、兩個 Redis 的狀態、各快取的命中率。任一來源失敗只顯示錯誤,不影響其他欄位 */
export class OverviewService {
  constructor(
    private readonly clients: Clients,
    private readonly redis: Redis,
    private readonly cacheRedis: Redis,
  ) {}

  async overview() {
    const settle = async <T>(p: Promise<T>): Promise<T | { error: string }> => p.catch((e: Error) => ({ error: e.message }));
    const [authS, chatS, billingS, stateInfo, cacheInfo, rawCache] = await Promise.all([
      settle(this.clients.auth.get('/internal/stats')),
      settle(this.clients.chat.get('/internal/stats')),
      settle(this.clients.billing.get('/internal/stats')),
      settle(redisSummary(this.redis)),
      settle(redisSummary(this.cacheRedis)),
      this.redis.hgetall('metrics:cache').catch(() => ({}) as Record<string, string>),
    ]);

    // metrics:cache 欄位格式:{service}.{namespace}.{hit|miss|error|coalesced}
    const ns: Record<string, Record<string, number>> = {};
    for (const [field, v] of Object.entries(rawCache)) {
      const [service, name, kind] = field.split('.');
      const key = `${service}/${name}`;
      (ns[key] ??= {})[kind!] = Number(v);
    }
    const cache = Object.entries(ns).map(([name, k]) => {
      const hit = k.hit ?? 0;
      const total = hit + (k.miss ?? 0) + (k.coalesced ?? 0);
      return { name, ...k, hit_rate: total > 0 ? (hit + (k.coalesced ?? 0)) / total : null };
    });
    return { auth: authS, chat: chatS, billing: billingS, redis: { state: stateInfo, cache: cacheInfo }, cache };
  }
}
