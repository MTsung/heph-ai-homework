import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { acquireLock, CacheStats, Lua, releaseLock } from '../../../shared/redis';
import type { Logger } from '../../../shared/log';

export interface MessageDto {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  error_code?: string | null;
  client_msg_id?: string | null;
  created_at: string;
}

/**
 * 「最近 N 則訊息」快取(每個對話一個 Redis List,放在 redis-cache)。
 * 同一份資料服務兩個最熱的讀取路徑:
 *   1. 每次送訊息要組 LLM 上下文
 *   2. App 打開對話時的第一頁歷史
 * 兩者原本都是每次打 DB。
 *
 * 一致性設計(DB 是真相來源,快取只是副本):
 *   - 寫入順序:DB commit 之後才更新快取;更新失敗不影響請求,只會讓快取作廢。
 *   - upsert 以 seq 為準,用 Lua 原子完成:
 *       末筆 seq == 新 seq     → 覆蓋末筆(訊息狀態更新:streaming → completed/failed)
 *       末筆 seq + 1 == 新 seq → 附加
 *       其他(空洞/亂序)       → 刪除整個 key,下次讀取時重建
 *   - key 不存在時 upsert 一律不做事,不會憑空建出「只含最後一兩則」的殘缺列表。
 *   - 重建採「先安裝、再驗證」:安裝後對照 conversations.next_seq,不一致就作廢。
 *     這樣重建期間若有新訊息提交,不是被後續 upsert 正確附加,就是被驗證步驟發現並作廢。
 */
const UPSERT = new Lua(`
local last = redis.call('LINDEX', KEYS[1], -1)
if not last then return 0 end
local lastSeq = cjson.decode(last).seq
local seq = tonumber(ARGV[1])
if lastSeq == seq then
  redis.call('LSET', KEYS[1], -1, ARGV[2])
elseif lastSeq + 1 == seq then
  redis.call('RPUSH', KEYS[1], ARGV[2])
  redis.call('LTRIM', KEYS[1], -tonumber(ARGV[3]), -1)
else
  redis.call('DEL', KEYS[1])
  return -1
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`);

const INSTALL_IF_ABSENT = new Lua(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for i = 2, #ARGV do redis.call('RPUSH', KEYS[1], ARGV[i]) end
if #ARGV > 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return 1
`);

const key = (convId: string) => `recent:${convId}`;

export class RecentCache {
  constructor(
    private readonly redis: Redis,
    private readonly pool: Pool,
    private readonly stats: CacheStats,
    private readonly log: Logger,
    private readonly size: number,
    private readonly ttlSec: number,
  ) {}

  /** 新增或更新一則訊息。永不丟例外:快取壞了不能影響聊天。 */
  async upsert(m: MessageDto): Promise<void> {
    try {
      await UPSERT.run(this.redis, [key(m.conversation_id)], [m.seq, JSON.stringify(m), this.size, this.ttlSec]);
    } catch (e) {
      this.log.warn({ err: (e as Error).message, conv: m.conversation_id }, 'recent cache upsert failed');
      await this.redis.del(key(m.conversation_id)).catch(() => undefined);
    }
  }

  async invalidate(convId: string): Promise<void> {
    await this.redis.del(key(convId)).catch(() => undefined);
  }

  /** 取得最近訊息(依 seq 由舊到新)。快取失效時從 DB 重建;Redis 掛掉時直接讀 DB。 */
  async get(convId: string): Promise<MessageDto[]> {
    try {
      const raw = await this.redis.lrange(key(convId), 0, -1);
      if (raw.length > 0) {
        this.stats.record('recent', 'hit');
        return raw.map((s) => JSON.parse(s) as MessageDto);
      }
    } catch (e) {
      this.stats.record('recent', 'error');
      this.log.warn({ err: (e as Error).message }, 'recent cache read failed, fallback to db');
      return this.loadFromDb(convId);
    }
    this.stats.record('recent', 'miss');
    return this.rebuild(convId);
  }

  private async loadFromDb(convId: string): Promise<MessageDto[]> {
    const { rows } = await this.pool.query<MessageDto>(
      `SELECT id, conversation_id, seq, role, content, status, error_code, client_msg_id, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2`,
      [convId, this.size],
    );
    return rows.reverse();
  }

  private async rebuild(convId: string): Promise<MessageDto[]> {
    // single-flight:同一個對話同時多個請求 miss 時,只讓一個去讀 DB 並回填
    const lockKey = `lock:rebuild:${key(convId)}`;
    const token = await acquireLock(this.redis, lockKey, 5000).catch(() => null);
    try {
      if (!token) {
        await new Promise((r) => setTimeout(r, 80));
        const again = await this.redis.lrange(key(convId), 0, -1).catch(() => []);
        if (again.length > 0) {
          this.stats.record('recent', 'coalesced');
          return again.map((s) => JSON.parse(s) as MessageDto);
        }
      }
      const rows = await this.loadFromDb(convId);
      if (rows.length === 0) return rows;
      try {
        await INSTALL_IF_ABSENT.run(this.redis, [key(convId)], [this.ttlSec, ...rows.map((r) => JSON.stringify(r))]);
        // 驗證:快取末筆必須等於 DB 目前最新的 seq,否則重建期間有新訊息提交 → 作廢
        const { rows: c } = await this.pool.query<{ next_seq: number }>(
          'SELECT next_seq FROM conversations WHERE id = $1',
          [convId],
        );
        if (c[0] && rows[rows.length - 1]!.seq !== c[0].next_seq - 1) {
          await this.invalidate(convId);
          return this.loadFromDb(convId);
        }
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'recent cache rebuild install failed');
      }
      return rows;
    } finally {
      if (token) await releaseLock(this.redis, lockKey, token).catch(() => undefined);
    }
  }
}
