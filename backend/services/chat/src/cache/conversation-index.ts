import { Errors } from '@chat-app/shared/errors';
import type { ConversationRepository } from '../repositories/conversation.repository';

/**
 * 對話的 owner / character 在建立後永遠不變 → 適合放行程內快取(L1),
 * 每次送訊息、翻歷史都要驗證「這個對話是不是你的」,不需要每次都查 DB。
 */
export class ConversationIndex {
  private map = new Map<string, { userId: string; characterId: string; exp: number }>();

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly max = 50_000,
    private readonly ttlMs = 600_000,
  ) {}

  /** 非本人的對話一律回 404(不洩漏對話是否存在)。 */
  async owned(convId: string, userId: string): Promise<{ id: string; characterId: string }> {
    const hit = this.map.get(convId);
    if (hit && hit.exp > Date.now()) {
      if (hit.userId !== userId) throw Errors.notFound('找不到對話');
      return { id: convId, characterId: hit.characterId };
    }
    const row = await this.conversations.findOwner(convId);
    if (!row || row.user_id !== userId) throw Errors.notFound('找不到對話');
    if (this.map.size >= this.max) this.map.clear();
    this.map.set(convId, { userId: row.user_id, characterId: row.character_id, exp: Date.now() + this.ttlMs });
    return { id: convId, characterId: row.character_id };
  }

  forget(convId: string): void {
    this.map.delete(convId);
  }
}
