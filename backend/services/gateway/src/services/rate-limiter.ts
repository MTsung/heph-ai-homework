import type Redis from 'ioredis';
import { Errors } from '@chat-app/shared/errors';
import { rateLimit } from '@chat-app/shared/redis';

/** 每分鐘固定視窗限流;超過就丟 429(Redis 故障時放行,見 shared/redis.ts)。 */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async enforce(key: string, limitPerMin: number): Promise<void> {
    const r = await rateLimit(this.redis, key, limitPerMin, 60_000);
    if (!r.allowed) throw Errors.tooMany(r.retryAfterSec);
  }
}
