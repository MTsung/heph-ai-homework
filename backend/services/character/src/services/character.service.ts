import type Redis from 'ioredis';
import { channels } from '@chat-app/shared/config';
import { Errors } from '@chat-app/shared/errors';
import type { CacheAside } from '@chat-app/shared/redis';
import { characterSeeds } from '../db/seed';
import type { CharacterRepository } from '../repositories/character.repository';
import type { CharacterInput } from '../schemas';
import { toPublicView, type CharacterRow, type PublicCharacter } from '../types';

/**
 * 角色資料。讀取走 cache-aside(redis-cache);修改後先寫 DB 再刪快取,
 * 並 PUBLISH evt:character,讓各服務(例如 chat)清掉自己的本機快取。
 */
export class CharacterService {
  constructor(
    private readonly repo: CharacterRepository,
    private readonly cache: CacheAside,
    /** state Redis:發布變更事件 */
    private readonly redis: Redis,
    private readonly cacheTtlSec: number,
  ) {}

  async seedDefaults(): Promise<void> {
    for (const s of characterSeeds) await this.repo.insertSeedIfAbsent(s);
  }

  // ---------------------------------------------------------------- 對外
  async listPublic(): Promise<PublicCharacter[]> {
    return (await this.cache.get('list', this.cacheTtlSec, async () => (await this.repo.listActive()).map(toPublicView))) ?? [];
  }

  async getPublic(id: string): Promise<PublicCharacter> {
    const ch = await this.getCached(id);
    if (!ch || ch.status !== 'active') throw Errors.notFound('角色不存在');
    return toPublicView(ch);
  }

  // ---------------------------------------------------------------- 內部(含 persona)
  async getInternal(id: string): Promise<CharacterRow> {
    const ch = await this.getCached(id);
    if (!ch) throw Errors.notFound('角色不存在');
    return ch;
  }

  listAll(): Promise<CharacterRow[]> {
    return this.repo.listAll();
  }

  async create(b: CharacterInput): Promise<CharacterRow> {
    try {
      const row = await this.repo.insert(b);
      await this.invalidate();
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('SLUG_TAKEN', 'slug 已存在');
      throw e;
    }
  }

  async update(id: string, b: CharacterInput): Promise<CharacterRow> {
    const row = await this.repo.update(id, b);
    if (!row) throw Errors.notFound('角色不存在');
    // 先寫 DB 再刪快取;並廣播,讓各服務清掉自己的本機快取
    await this.invalidate(id);
    return row;
  }

  // ---------------------------------------------------------------- 快取
  private getCached(id: string): Promise<CharacterRow | null> {
    return this.cache.get<CharacterRow>(`id:${id}`, this.cacheTtlSec, () => this.repo.findById(id));
  }

  private async invalidate(id?: string): Promise<void> {
    await this.cache.del('list', ...(id ? [`id:${id}`] : []));
    await this.redis.publish(channels.characterEvents, JSON.stringify({ id: id ?? null })).catch(() => undefined);
  }
}
