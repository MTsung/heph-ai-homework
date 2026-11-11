import type { ServiceClient } from '@chat-app/shared/client';

export interface CharacterInfo {
  id: string;
  slug: string;
  name: string;
  persona: string;
  greeting: string;
  price: number;
  model: string | null;
  status: 'active' | 'disabled';
}

/**
 * 角色資料的本機(in-process)快取,是 character-service 的 Redis 快取之前的第一層:
 * 每次送訊息都需要 persona 與 price,不能每次都打一趟 HTTP。
 *  - TTL 60 秒作為保底
 *  - character-service 修改角色時會發 Pub/Sub,收到後立刻 invalidate
 *  - 同一個 id 同時多個請求 miss 時共用一個 in-flight 請求(避免擊穿)
 */
export class CharacterDirectory {
  private cache = new Map<string, { value: CharacterInfo; exp: number }>();
  private inflight = new Map<string, Promise<CharacterInfo>>();

  constructor(
    private readonly client: ServiceClient,
    private readonly ttlMs = 60_000,
  ) {}

  async get(id: string): Promise<CharacterInfo> {
    const hit = this.cache.get(id);
    if (hit && hit.exp > Date.now()) return hit.value;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.client
        .get<CharacterInfo>(`/internal/characters/${id}`)
        .then((v) => {
          this.cache.set(id, { value: v, exp: Date.now() + this.ttlMs });
          return v;
        })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  invalidate(id?: string | null): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }
}
