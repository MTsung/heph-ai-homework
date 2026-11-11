import { hostname } from 'node:os';
import type Redis from 'ioredis';
import { streams } from '@chat-app/shared/config';
import { StreamConsumer } from '@chat-app/shared/events';
import type { Logger } from '@chat-app/shared/log';
import type { RecentMessagesCache } from '../cache/recent-messages.cache';
import type { GenerationLock } from '../generation/generation-lock';
import type { GenerationManager } from '../generation/generation-manager';
import type { ConversationService } from '../services/conversation.service';

interface Deps {
  manager: GenerationManager;
  conversations: ConversationService;
  recent: RecentMessagesCache;
  lock: GenerationLock;
  log: Logger;
}

/** 刪除帳號事件(冪等):中止進行中的生成,刪掉對話與訊息,清掉相關快取與鎖 */
export function userDeletedConsumer(redis: Redis, { manager, conversations, recent, lock, log }: Deps): StreamConsumer {
  return new StreamConsumer(
    redis,
    streams.userEvents,
    'chat',
    `chat-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      manager.abortUser(userId); // 先中止這位使用者進行中的生成
      const convIds = await conversations.deleteUserData(userId);
      for (const id of convIds) {
        await recent.invalidate(id);
        await lock.clear(id).catch(() => undefined);
      }
      log.info({ userId, conversations: convIds.length }, 'chat data deleted for user');
    },
    log,
  );
}
