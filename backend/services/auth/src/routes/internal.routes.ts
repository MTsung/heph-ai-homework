import { createRouter } from '@chat-app/shared/app';
import { Errors, parse } from '@chat-app/shared/errors';
import { userIdParam, userSearchQuery } from '../schemas';
import type { AuthService } from '../services/auth.service';
import type { SessionService } from '../services/session.service';

/** 內部(gateway / admin 使用) */
export function internalRoutes({ auth, sessions }: { auth: AuthService; sessions: SessionService }) {
  const r = createRouter();

  /** gateway 在 Redis 沒有 session 快取時的回源查詢(DB 是 session 的真相來源)。 */
  r.get('/internal/sessions/:userId', async (c) => {
    const s = await sessions.find(c.req.param('userId'));
    if (!s) throw Errors.notFound('沒有有效的 session');
    return c.json({ sid: s.sid, device_name: s.device_name });
  });

  r.get('/internal/users', async (c) => {
    const q = parse(userSearchQuery, c.req.query());
    return c.json({ items: await auth.searchUsers(q) });
  });

  r.get('/internal/users/:id', async (c) => {
    return c.json(await auth.getUser(parse(userIdParam, c.req.param('id'))));
  });

  r.post('/internal/users/:id/logout', async (c) => {
    const revoked = await sessions.revoke(parse(userIdParam, c.req.param('id')));
    return c.json({ revoked });
  });

  r.get('/internal/stats', async (c) => c.json(await auth.stats()));

  return r;
}
