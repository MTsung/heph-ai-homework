import { Errors } from '@chat-app/shared/errors';
import type { FailoverProvider } from '@chat-app/shared/llm';
import type { GenerationManager } from '../generation/generation-manager';
import type { GenerationStreamStore } from '../generation/stream-store';
import type { ConversationRepository } from '../repositories/conversation.repository';
import type { MessageRepository } from '../repositories/message.repository';
import { toDto } from '../types';

/** 後台與除錯用的唯讀查詢(不檢查 owner;只經 internal token 存取) */
export class InspectionService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly manager: GenerationManager,
    private readonly streamStore: GenerationStreamStore,
    /** 備援鏈(提供各供應商的健康狀態) */
    private readonly provider: FailoverProvider,
  ) {}

  listConversations(userId: string, limit: number) {
    return this.conversations.listForAdmin(userId, limit);
  }

  /** 由舊到新 */
  async listMessages(conversationId: string, beforeSeq: number | null, limit: number) {
    return (await this.messages.listForAdmin(conversationId, beforeSeq, limit)).reverse();
  }

  async stats() {
    return {
      ...(await this.messages.stats()),
      active_generations_this_instance: this.manager.activeCount,
      // 各供應商的健康狀態(只代表回應這次請求的這一個 instance)
      llm: this.provider.status(),
    };
  }

  /** 某則 AI 訊息在 Redis 的串流進度(除錯續傳時使用) */
  async streamProgress(messageId: string) {
    return { entries: await this.streamStore.count(messageId), local: !!this.manager.get(messageId) };
  }

  async message(messageId: string) {
    const row = await this.messages.findFull(messageId);
    if (!row) throw Errors.notFound('找不到訊息');
    return {
      ...toDto(row),
      billing_state: row.billing_state,
      attempt: row.attempt,
      hold_ref: row.hold_ref,
      // 實際由哪個供應商/模型回覆,以及用了多少 token(成本對帳用)
      model: row.model,
      provider: row.provider,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    };
  }
}
