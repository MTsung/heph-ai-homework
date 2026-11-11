import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { tx } from '@chat-app/shared/db';
import { AppError, Errors } from '@chat-app/shared/errors';
import type { CharacterDirectory, CharacterInfo } from '../clients/character.client';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import type { ConversationView } from '../types';

/** 對話:列表、建立(含開場白)、刪除使用者資料 */
export class ConversationService {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;

  constructor(
    private readonly pool: Pool,
    private readonly directory: CharacterDirectory,
  ) {
    this.conversations = new ConversationRepository(pool);
    this.messages = new MessageRepository(pool);
  }

  list(userId: string): Promise<ConversationView[]> {
    return this.conversations.listByUser(userId);
  }

  /** 一位使用者與一個角色只有一條對話:已存在就回傳原本那條(created = false) */
  async create(userId: string, characterId: string): Promise<{ conversation: ConversationView; created: boolean }> {
    let character: CharacterInfo;
    try {
      character = await this.directory.get(characterId);
    } catch (e) {
      if (e instanceof AppError && e.status === 404) throw Errors.notFound('角色不存在');
      throw e;
    }
    if (character.status !== 'active') throw Errors.notFound('角色不存在');

    const created = await tx(this.pool, async (c) => {
      const conversations = new ConversationRepository(c);
      const id = await conversations.insertIfAbsent(randomUUID(), userId, characterId);
      if (!id) return null;
      // 角色的開場白當作第一則訊息(seq=1),讓對話一開始就有內容
      await new MessageRepository(c).insertGreeting({ id: randomUUID(), conversationId: id, userId, content: character.greeting });
      await conversations.setPreview(id, character.greeting.slice(0, 60));
      return id;
    });
    const conversation = (await this.conversations.findByUserAndCharacter(userId, characterId))!;
    return { conversation, created: !!created };
  }

  /** 刪除帳號:刪掉這位使用者的所有訊息與對話,回傳被刪的對話 id(冪等) */
  async deleteUserData(userId: string): Promise<string[]> {
    const ids = await this.conversations.listIdsByUser(userId);
    // 分批刪除,避免一個超大 transaction 長時間鎖表
    while ((await this.messages.deleteBatchByUser(userId, 5000)) > 0) {
      /* 繼續下一批 */
    }
    await this.conversations.deleteByUser(userId);
    return ids;
  }
}
