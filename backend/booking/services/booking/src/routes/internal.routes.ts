import { createRouter } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { internalListQuery, uuid } from '../schemas';
import type { InspectionService } from '../services/inspection.service';

/** 內部 API(admin / 客服) */
export function internalRoutes({ inspection }: { inspection: InspectionService }) {
  const r = createRouter();

  r.get('/internal/bookings', async (c) => {
    const q = parse(internalListQuery, c.req.query());
    return c.json(await inspection.listByUser(q.user_id, q.limit));
  });

  r.get('/internal/bookings/:id', async (c) => c.json(await inspection.get(parse(uuid, c.req.param('id')))));

  r.get('/internal/stats', async (c) => c.json(await inspection.stats()));

  return r;
}
