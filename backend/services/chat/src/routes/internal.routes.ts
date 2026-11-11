import { createRouter } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { internalConversationsQuery, internalMessagesQuery, uuid } from '../schemas';
import type { InspectionService } from '../services/inspection.service';

/** 內部 API(admin 使用) */
export function internalRoutes({ inspection }: { inspection: InspectionService }) {
  const r = createRouter();

  r.get('/internal/conversations', async (c) => {
    const q = parse(internalConversationsQuery, c.req.query());
    return c.json({ items: await inspection.listConversations(q.user_id, q.limit) });
  });

  r.get('/internal/conversations/:id/messages', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const q = parse(internalMessagesQuery, c.req.query());
    return c.json({ items: await inspection.listMessages(id, q.before_seq ?? null, q.limit) });
  });

  r.get('/internal/stats', async (c) => c.json(await inspection.stats()));

  /** 診斷用:看某則 AI 訊息在 Redis 的串流進度(除錯續傳時使用)。 */
  r.get('/internal/debug/stream/:mid', async (c) => c.json(await inspection.streamProgress(parse(uuid, c.req.param('mid')))));

  r.get('/internal/message/:mid', async (c) => c.json(await inspection.message(parse(uuid, c.req.param('mid')))));

  return r;
}
