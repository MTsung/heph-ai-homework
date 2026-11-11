import { createRouter, readJson, requireUser, type Ctx } from '@chat-app/shared/app';
import { AppError, Errors, parse } from '@chat-app/shared/errors';
import { confirmBody, createBody, detectBody, listQuery, messageBody, slotsBody, uuid } from '../schemas';
import type { BookingService } from '../services/booking.service';
import { decodeCursor } from '../views/booking.view';

/** 繁忙時多回一個標準的 Retry-After 標頭 */
async function withRetryAfter<T>(c: Ctx, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && typeof e.extra?.retry_after === 'number') c.header('retry-after', String(e.extra.retry_after));
    throw e;
  }
}

/** 對外 API(經 gateway,已帶 x-user-id) */
export function bookingRoutes({ bookings }: { bookings: BookingService }) {
  const r = createRouter();

  // 免費的需求判斷(純規則)。一般聊天不會因為這個多花點數
  r.post('/bookings/detect', async (c) => {
    requireUser(c);
    const b = parse(detectBody, await readJson(c));
    return c.json(bookings.detect(b.text));
  });

  r.post('/bookings', async (c) => {
    const { userId } = requireUser(c);
    const res = await bookings.create(userId, parse(createBody, await readJson(c)));
    return c.json(res.view, res.created ? 201 : 200);
  });

  r.get('/bookings', async (c) => {
    const { userId } = requireUser(c);
    const q = parse(listQuery, c.req.query());
    const before = q.before ? decodeCursor(q.before) : undefined;
    if (before === null) throw Errors.badRequest('before 游標無效');
    return c.json(
      await bookings.list(userId, {
        view: q.view ?? q.status ?? 'all',
        limit: q.limit,
        result: q.result,
        includeDrafts: q.include_drafts === 'true',
        before,
      }),
    );
  });

  r.get('/bookings/:id', async (c) => c.json(await bookings.get(requireUser(c).userId, parse(uuid, c.req.param('id')))));

  r.post('/bookings/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await bookings.message(userId, parse(uuid, c.req.param('id')), parse(messageBody, await readJson(c))));
  });

  r.patch('/bookings/:id/slots', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await bookings.setSlots(userId, parse(uuid, c.req.param('id')), parse(slotsBody, await readJson(c))));
  });

  r.post('/bookings/:id/confirm', async (c) => {
    const { userId } = requireUser(c);
    const id = parse(uuid, c.req.param('id'));
    const b = parse(confirmBody, await readJson(c));
    return c.json(await withRetryAfter(c, () => bookings.confirm(userId, id, b.plan_hash)), 202);
  });

  r.post('/bookings/:id/cancel', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await bookings.cancel(userId, parse(uuid, c.req.param('id'))));
  });

  return r;
}
