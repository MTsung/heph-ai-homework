import { randomUUID } from 'node:crypto';
import { AppError, Errors } from '@chat-app/shared/errors';
import type { ConversationIndex } from '../cache/conversation-index';
import type { RecentMessagesCache } from '../cache/recent-messages.cache';
import type { BillingClient } from '../clients/billing.client';
import type { CharacterDirectory } from '../clients/character.client';
import type { ChatConfig } from '../config';
import type { ContextBuilder } from '../generation/context-builder';
import type { Generation } from '../generation/generation';
import type { GenerationLock } from '../generation/generation-lock';
import type { GenerationManager } from '../generation/generation-manager';
import type { ConversationRepository } from '../repositories/conversation.repository';
import type { MessageRepository } from '../repositories/message.repository';
import type { HistoryQuery, SendMessageInput } from '../schemas';
import { toDto, type MessageDto, type MessageRow } from '../types';
import type { SettlementService } from './settlement.service';

/**
 * 送出訊息的結果,交給 streaming/message-streamer.ts 輸出成 SSE:
 *   replay   這則訊息已處理過(冪等重送),回放既有的 AI 回覆(或接上進行中的生成)
 *   generate 新的生成已建立但還沒開始:呼叫端掛上訂閱者後再 start,才不會漏掉最前面的片段
 */
export type SendOutcome =
  | { kind: 'replay'; user: MessageRow; assistant: MessageRow }
  | {
      kind: 'generate';
      user: MessageDto;
      assistant: { id: string; seq: number; created_at: string };
      generation: Generation;
    };

export interface MessageServiceDeps {
  messages: MessageRepository;
  conversations: ConversationRepository;
  index: ConversationIndex;
  recent: RecentMessagesCache;
  directory: CharacterDirectory;
  billing: BillingClient;
  settlement: SettlementService;
  lock: GenerationLock;
  manager: GenerationManager;
  context: ContextBuilder;
  /** 角色沒指定模型時寫進訊息的預設模型 */
  defaultModel: () => string;
  cfg: Pick<ChatConfig, 'maxActive'>;
  /** 服務正在關閉:不接新的生成 */
  isDraining: () => boolean;
}

export class MessageService {
  constructor(private readonly d: MessageServiceDeps) {}

  // ======================================================================= 歷史訊息
  /**
   * 三種讀法,全部以 seq(對話內嚴格遞增、無空洞)當游標,不用 offset、也不用時間戳:
   *   (無參數)    最新一頁   → 優先讀 Redis 最近訊息快取
   *   before_seq  往上滑     → keyset:WHERE seq < ? ORDER BY seq DESC LIMIT ?,走 UNIQUE(conversation_id, seq)
   *   after_seq   補同步     → 另一台裝置/重新連線後,把漏掉的訊息撈回來
   */
  async history(userId: string, convId: string, q: HistoryQuery) {
    const { d } = this;
    await d.index.owned(convId, userId);

    if (q.after_seq !== undefined) {
      const rows = await d.messages.listAfter(convId, q.after_seq, q.limit);
      return { items: rows.map(toDto), has_more_before: false, has_more_after: rows.length === q.limit };
    }

    if (q.before_seq === undefined) {
      const cached = await d.recent.get(convId);
      // 快取涵蓋得夠(或已經包含對話的第一則)才直接用,否則走 DB
      if (cached.length > 0 && (cached.length >= q.limit || cached[0]!.seq === 1)) {
        const items = cached.slice(-q.limit);
        return { items, has_more_before: items[0]!.seq > 1, has_more_after: false };
      }
    }

    const rows = await d.messages.listBefore(convId, q.before_seq ?? null, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).reverse().map(toDto);
    return { items, has_more_before: hasMore, has_more_after: false };
  }

  /** 續傳:找出要接著看的 AI 訊息 */
  async findForResume(userId: string, convId: string, messageId: string): Promise<MessageRow> {
    await this.d.index.owned(convId, userId);
    const row = await this.d.messages.findAssistant(convId, messageId);
    if (!row) throw Errors.notFound('找不到訊息');
    return row;
  }

  // ======================================================================= 送訊息
  async send(userId: string, convId: string, body: SendMessageInput): Promise<SendOutcome> {
    const { d } = this;
    if (d.isDraining()) throw new AppError(503, 'SERVER_DRAINING', '服務更新中,請稍後重試');
    const conv = await d.index.owned(convId, userId);

    // ---- 冪等:同一個 client_msg_id 重送(網路中斷後重試),不會產生第二則訊息、也不會重複扣點
    const existingUser = await d.messages.findByClientMsgId(convId, body.client_msg_id);
    if (existingUser) {
      const asst = await d.messages.findBySeq(convId, existingUser.seq + 1);
      if (!asst) throw Errors.conflict('INCONSISTENT', '訊息狀態異常,請聯絡客服');
      if (asst.status === 'failed') return this.regenerate(userId, conv, existingUser, asst);
      return { kind: 'replay', user: existingUser, assistant: asst };
    }

    // ---- 負載保護:這台 instance 同時生成數已滿就快速拒絕(客戶端稍後重試 / 上游改打別台)
    this.assertCapacity();

    // ---- 每個對話同一時間只允許一個進行中的回覆(鎖的值 = AI 訊息 id,reaper 用它判斷鎖是否仍屬於該訊息)
    const assistantId = randomUUID();
    const userMsgId = randomUUID();
    const token = await d.lock.acquire(convId, assistantId).catch(() => {
      throw Errors.unavailable('系統暫時無法處理,請稍後再試');
    });
    if (!token) {
      throw Errors.conflict('GENERATION_IN_PROGRESS', 'AI 正在回覆上一則訊息,請稍候');
    }

    const holdRef = `${assistantId}#0`;
    let held = false;
    try {
      const character = await d.directory.get(conv.characterId);
      if (character.status !== 'active') throw Errors.conflict('CHARACTER_UNAVAILABLE', '這個角色目前無法聊天');

      // ---- 1) 預扣點數(不足 → 402;billing 掛了 → 503。此時還沒寫任何訊息,失敗乾淨俐落)
      // 注意「結果未知」:逾時/網路錯誤時,billing 可能已經提交了預扣,只是回應沒回來。
      // 所以只要請求「發出過」就視為可能已預扣;只有明確收到 4xx(例如 402)才能確定沒有預扣。
      // 失敗路徑會 release 這個 ref(release 是冪等的,對不存在的 ref 是 no-op)。
      held = true;
      try {
        await d.billing.hold(holdRef, userId, character.price);
      } catch (e) {
        if (e instanceof AppError && e.status >= 400 && e.status < 500) held = false; // 明確被拒絕:確定沒有預扣
        throw e;
      }

      // ---- 2) 配號 + 寫入 user 訊息與 AI 訊息(placeholder),單一語句、整體原子
      const rows = await d.messages.insertExchange({
        conversationId: convId,
        userMessageId: userMsgId,
        userId,
        content: body.content,
        clientMsgId: body.client_msg_id,
        assistantId,
        model: character.model ?? d.defaultModel(),
        holdRef,
      });
      const userDto = toDto(rows.user);
      const asstDto = toDto(rows.assistant);
      await d.recent.upsert(userDto);
      await d.recent.upsert(asstDto);

      // ---- 3) 建立生成(由呼叫端掛上訂閱者後 start)
      const messages = await d.context.build(character, convId, rows.user.seq, body.content);
      const generation = d.manager.create({
        assistantId,
        conversationId: convId,
        userId,
        seq: rows.assistant.seq,
        holdRef,
        character,
        messages,
        createdAt: asstDto.created_at,
      });
      return {
        kind: 'generate',
        user: userDto,
        assistant: { id: assistantId, seq: rows.assistant.seq, created_at: asstDto.created_at },
        generation,
      };
    } catch (e) {
      // 還沒交給 Generation 之前出錯:釋放鎖、歸還預扣(歸還失敗會記下來由 reaper 重試,不會吞掉)
      await d.lock.release(convId, token).catch(() => undefined);
      if (held) await d.settlement.releaseOrDefer(holdRef);
      if ((e as { code?: string }).code === '23505') {
        // 兩個相同 client_msg_id 的請求同時到達,另一個先寫入了:請客戶端再送一次,會走冪等分支
        throw Errors.conflict('DUPLICATE_IN_FLIGHT', '相同的訊息正在處理中,請稍後重試');
      }
      throw e;
    }
  }

  /** 重試失敗的回覆:沿用同一則 AI 訊息(同 seq),用新的預扣 ref(#attempt),歷史裡不會留下殘骸。 */
  private async regenerate(
    userId: string,
    conv: { id: string; characterId: string },
    userMsg: MessageRow,
    asst: MessageRow,
  ): Promise<SendOutcome> {
    const { d } = this;
    this.assertCapacity();
    const nextSeq = await d.conversations.nextSeq(conv.id);
    if (nextSeq! - 1 !== asst.seq) {
      throw Errors.conflict('RETRY_NOT_LATEST', '只能重試最新一則的回覆');
    }
    const token = await d.lock.acquire(conv.id, asst.id).catch(() => null);
    if (!token) throw Errors.conflict('GENERATION_IN_PROGRESS', 'AI 正在回覆上一則訊息,請稍候');

    const attempt = asst.attempt + 1;
    const holdRef = `${asst.id}#${attempt}`;
    let held = false;
    try {
      // 上一次嘗試的預扣必須先歸還(同步、冪等),否則覆寫 hold_ref 後它就沒人管了
      if (asst.hold_ref) await d.billing.release(asst.hold_ref);
      const character = await d.directory.get(conv.characterId);
      held = true; // 同上:逾時時結果未知,失敗路徑一律補償 release
      try {
        await d.billing.hold(holdRef, userId, character.price);
      } catch (e) {
        if (e instanceof AppError && e.status >= 400 && e.status < 500) held = false;
        throw e;
      }
      const row = await d.messages.restartFailed(asst.id, attempt, holdRef);
      if (!row) throw Errors.conflict('RETRY_CONFLICT', '這則回覆的狀態已改變');
      const rowDto = toDto(row);
      await d.recent.upsert(rowDto);

      const messages = await d.context.build(character, conv.id, userMsg.seq, userMsg.content);
      const generation = d.manager.create({
        assistantId: asst.id,
        conversationId: conv.id,
        userId,
        seq: asst.seq,
        holdRef,
        character,
        messages,
        createdAt: rowDto.created_at,
      });
      return {
        kind: 'generate',
        user: toDto(userMsg),
        assistant: { id: asst.id, seq: asst.seq, created_at: rowDto.created_at },
        generation,
      };
    } catch (e) {
      await d.lock.release(conv.id, token).catch(() => undefined);
      if (held) await d.settlement.releaseOrDefer(holdRef);
      throw e;
    }
  }

  private assertCapacity(): void {
    if (this.d.manager.activeCount >= this.d.cfg.maxActive) {
      throw new AppError(503, 'SERVER_BUSY', '系統忙碌中,請稍後再試', { retry_after: 2 });
    }
  }
}
