import type Redis from 'ioredis';
import { Lua } from '../../../../shared/redis';

/**
 * 分散式「同時執行數」上限(counting semaphore),跨 replica 共用。
 *
 * 每個執行中的工作持有一張「租約」:ZSET 的成員是工作 id,分數是到期時間(ms)。
 *  - acquire:先清掉已到期的租約,再看數量是否還沒到上限;同一個成員重複 acquire 只會續期(冪等)
 *  - renew  :工作還在跑就定期續期;程序當機時不再續期,租約到期後名額自動歸還,不會永久卡死
 *  - release:工作結束時主動歸還
 *
 * 取捨:使用單一 Redis 節點,以 Lua 保證「檢查數量 + 加入」是原子的。Redis 不可用時 acquire 會丟錯,
 * 呼叫端應視為「忙碌」而不是放行 —— 這個上限保護的是下游(模擬器 / 對方網站),寧可擋也不要失控。
 */
const ACQUIRE = new Lua(`
local now = tonumber(ARGV[1])
redis.call('zremrangebyscore', KEYS[1], '-inf', now)
if redis.call('zscore', KEYS[1], ARGV[3]) then
  redis.call('zadd', KEYS[1], now + tonumber(ARGV[4]), ARGV[3])
  return 1
end
if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('zadd', KEYS[1], now + tonumber(ARGV[4]), ARGV[3])
redis.call('pexpire', KEYS[1], tonumber(ARGV[4]) * 4)
return 1
`);

const RENEW = new Lua(`
if redis.call('zscore', KEYS[1], ARGV[2]) then
  redis.call('zadd', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[2])
  return 1
end
return 0
`);

export class ConcurrencyLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    readonly max: number,
    private readonly leaseMs = 30_000,
  ) {}

  private get key(): string {
    return `limit:${this.name}`;
  }

  /** true = 拿到名額(或本來就持有) */
  async acquire(member: string): Promise<boolean> {
    return Number(await ACQUIRE.run(this.redis, [this.key], [Date.now(), this.max, member, this.leaseMs])) === 1;
  }

  /** 續期。回傳 false 代表租約已經遺失(例如 Redis 重啟或太久沒續期) */
  async renew(member: string): Promise<boolean> {
    return Number(await RENEW.run(this.redis, [this.key], [Date.now(), member, this.leaseMs])) === 1;
  }

  async release(member: string): Promise<void> {
    await this.redis.zrem(this.key, member);
  }

  /** 目前持有名額的數量(診斷用) */
  async inUse(): Promise<number> {
    await this.redis.zremrangebyscore(this.key, '-inf', Date.now());
    return this.redis.zcard(this.key);
  }
}
