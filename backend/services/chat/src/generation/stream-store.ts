import type Redis from 'ioredis';

const streamKey = (messageId: string) => `gen:${messageId}`;

export interface StreamEntry {
  id: string;
  /** n / t = 一段片段;end = 結束標記 */
  fields: Record<string, string>;
}

/**
 * 生成中的回覆在 Redis Stream 的副本(gen:{messageId})。用途:
 *   - 斷線續傳時,生成不在這台 instance → 從這裡追進度
 *   - instance 當機時,reaper 從這裡撈回已產生的文字
 * DB 才是真相;這份資料遺失是可以接受的。
 */
export class GenerationStreamStore {
  constructor(private readonly redis: Redis) {}

  async append(messageId: string, n: number, text: string): Promise<void> {
    const key = streamKey(messageId);
    await this.redis.multi().xadd(key, 'MAXLEN', '~', '5000', '*', 'n', String(n), 't', text).expire(key, 900).exec();
  }

  /** 寫入結束標記。之後只保留很短時間:DB 已有最終內容,這份只是為了讓還在追的訂閱者收尾 */
  async end(messageId: string, end: 'done' | 'error'): Promise<void> {
    const key = streamKey(messageId);
    await this.redis.multi().xadd(key, '*', 'end', end).expire(key, 120).exec();
  }

  /** 讀 lastId 之後的項目(lastId = '-' 表示從頭讀) */
  async readAfter(messageId: string, lastId: string, count: number): Promise<StreamEntry[]> {
    const raw = (await this.redis.xrange(streamKey(messageId), lastId === '-' ? '-' : `(${lastId}`, '+', 'COUNT', count)) as Array<
      [string, string[]]
    >;
    return raw.map(([id, fields]) => ({ id, fields: toRecord(fields) }));
  }

  /** 已產生的全部文字(當機補救用) */
  async readText(messageId: string): Promise<string> {
    const entries = (await this.redis.xrange(streamKey(messageId), '-', '+')) as Array<[string, string[]]>;
    let text = '';
    for (const [, fields] of entries) {
      for (let i = 0; i < fields.length; i += 2) if (fields[i] === 't') text += fields[i + 1];
    }
    return text;
  }

  async count(messageId: string): Promise<number> {
    return (await this.redis.xrange(streamKey(messageId), '-', '+')).length;
  }
}

function toRecord(fields: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
  return f;
}
