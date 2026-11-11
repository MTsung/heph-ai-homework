import type Redis from 'ioredis';
import { acquireLock, extendLock, releaseLock } from '@chat-app/shared/redis';

const lockKey = (conversationId: string) => `lock:gen:${conversationId}`;

/**
 * 對話層級的生成鎖:每個對話同一時間只允許一個進行中的回覆。
 * 鎖的值 = AI 訊息 id,reaper 用它判斷鎖是否仍屬於該訊息(不屬於 → 孤兒)。
 */
export class GenerationLock {
  constructor(
    private readonly redis: Redis,
    readonly ttlMs: number,
  ) {}

  /** 成功回傳 token(= ownerId);已被佔用回傳 null;Redis 故障丟錯 */
  acquire(conversationId: string, ownerId: string): Promise<string | null> {
    return acquireLock(this.redis, lockKey(conversationId), this.ttlMs, ownerId);
  }

  extend(conversationId: string, ownerId: string): Promise<boolean> {
    return extendLock(this.redis, lockKey(conversationId), ownerId, this.ttlMs);
  }

  release(conversationId: string, token: string): Promise<void> {
    return releaseLock(this.redis, lockKey(conversationId), token);
  }

  /** 目前持有鎖的 AI 訊息 id */
  owner(conversationId: string): Promise<string | null> {
    return this.redis.get(lockKey(conversationId));
  }

  /** 不比對 token 直接移除(只用在刪除帳號) */
  async clear(conversationId: string): Promise<void> {
    await this.redis.del(lockKey(conversationId));
  }
}
