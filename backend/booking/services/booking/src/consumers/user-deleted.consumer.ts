import { hostname } from 'node:os';
import type Redis from 'ioredis';
import { streams } from '@chat-app/shared/config';
import { StreamConsumer } from '@chat-app/shared/events';
import type { Logger } from '@chat-app/shared/log';
import type { BookingService } from '../services/booking.service';

/** 刪除帳號事件(冪等):刪掉這位使用者的訂位需求 */
export function userDeletedConsumer(redis: Redis, bookings: BookingService, log: Logger): StreamConsumer {
  return new StreamConsumer(
    redis,
    streams.userEvents,
    'booking',
    `booking-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      const n = await bookings.deleteUserData(userId);
      log.info({ userId, bookings: n }, 'booking data deleted for user');
    },
    log,
  );
}
