import { hostname } from 'node:os';
import type Redis from 'ioredis';
import { streams } from '@chat-app/shared/config';
import { StreamConsumer } from '@chat-app/shared/events';
import type { Logger } from '@chat-app/shared/log';
import type { AccountService } from '../services/account.service';

/** 刪除帳號事件(冪等):清掉這位使用者的點數資料 */
export function userDeletedConsumer(redis: Redis, accounts: AccountService, log: Logger): StreamConsumer {
  return new StreamConsumer(
    redis,
    streams.userEvents,
    'billing',
    `billing-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      await accounts.deleteUserData(userId);
      log.info({ userId }, 'billing data deleted for user');
    },
    log,
  );
}
