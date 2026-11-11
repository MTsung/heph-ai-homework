import { createRouter, readJson } from '@chat-app/shared/app';
import { Errors, parse } from '@chat-app/shared/errors';
import { grantBody, screenSequence, userListQuery, uuid } from '../schemas';
import type { BrowserTraceService } from '../services/browser-trace.service';
import type { OverviewService } from '../services/overview.service';
import type { SupportService } from '../services/support.service';

interface Deps {
  overview: OverviewService;
  support: SupportService;
  traces: BrowserTraceService;
}

/** 後台頁面呼叫的 /api/*(依需求:不做權限,只綁本機) */
export function apiRoutes({ overview, support, traces }: Deps) {
  const r = createRouter();

  // ---------------------------------------------------------------- 總覽
  r.get('/api/overview', async (c) => c.json(await overview.overview()));

  // ---------------------------------------------------------------- 使用者 / 點數
  r.get('/api/users', async (c) => c.json(await support.listUsers(parse(userListQuery, c.req.query()))));

  r.post('/api/users/:id/grant', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const b = parse(grantBody, await readJson(c));
    return c.json(await support.grant(id, b));
  });

  r.post('/api/users/:id/logout', async (c) => c.json(await support.forceLogout(parse(uuid, c.req.param('id')))));

  r.get('/api/users/:id/ledger', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    return c.json(await support.ledger(id, c.req.query('before_id')));
  });

  r.get('/api/users/:id/bookings', async (c) => c.json(await support.bookings(parse(uuid, c.req.param('id')))));

  r.get('/api/users/:id/conversations', async (c) => c.json(await support.conversations(parse(uuid, c.req.param('id')))));

  // ---------------------------------------------------------------- browser-use 開發執行紀錄(僅本機後台)
  r.get('/api/bookings/:id/browser-trace', async (c) => c.json(await traces.manifest(parse(uuid, c.req.param('id')))));

  r.get('/api/bookings/:id/browser-trace/screens/:sequence', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const sequence = parse(screenSequence, c.req.param('sequence'));
    const image = await traces.screenshot(id, sequence);
    return new Response(image, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  });

  r.get('/api/conversations/:id/messages', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    return c.json(await support.conversationMessages(id, c.req.query('before_seq')));
  });

  // ---------------------------------------------------------------- 角色
  r.get('/api/characters', async (c) => c.json(await support.listCharacters()));
  r.post('/api/characters', async (c) => c.json(await support.createCharacter(await readJson(c)), 201));
  r.put('/api/characters/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) throw Errors.notFound('角色不存在');
    return c.json(await support.updateCharacter(id, await readJson(c)));
  });

  return r;
}
