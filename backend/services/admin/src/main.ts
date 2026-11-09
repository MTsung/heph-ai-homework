import { z } from 'zod';
import { resolve, relative, sep } from 'node:path';
import { buildApp, onShutdown, readJson } from '../../../shared/app';
import { ServiceClient } from '../../../shared/client';
import { env, envInt, urls } from '../../../shared/config';
import { Errors, parse } from '../../../shared/errors';
import { createRedis } from '../../../shared/redis';

/**
 * 後台(依需求:簡單網頁、不做權限)。
 * 安全注意:這個服務沒有任何登入驗證,compose 只把它綁在 127.0.0.1;
 * 它也能讀取對話內容與調整點數,上線前必須加上身分驗證(SSO/RBAC)與操作稽核紀錄。
 */
async function main(): Promise<void> {
  const redis = createRedis('admin');
  const cacheRedis = createRedis('admin', 'cache');
  const auth = new ServiceClient('auth', urls.auth(), 5000);
  const character = new ServiceClient('character', urls.character(), 5000);
  const chat = new ServiceClient('chat', urls.chat(), 5000);
  const billing = new ServiceClient('billing', urls.billing(), 5000);
  const booking = new ServiceClient('booking', urls.booking(), 5000);

  const { app, log, listen } = buildApp({
    service: 'admin',
    internalAuth: false, // 後台是給人用的:/api 與頁面不檢查 internal token
    ready: async () => {
      await redis.ping();
    },
  });

  const uuid = z.string().uuid();
  const html = Bun.file(new URL('../public/index.html', import.meta.url).pathname);
  const artifactRoot = resolve(env('BROWSER_AGENT_ARTIFACT_DIR', '/var/lib/browser-agent/artifacts'));

  app.get('/', async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));

  // ---------------------------------------------------------------- 總覽
  function parseInfo(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  }

  async function redisSummary(r: typeof redis) {
    const info = parseInfo(await r.info());
    const hits = Number(info.keyspace_hits ?? 0);
    const misses = Number(info.keyspace_misses ?? 0);
    return {
      used_memory: info.used_memory_human,
      maxmemory_policy: info.maxmemory_policy,
      connected_clients: Number(info.connected_clients ?? 0),
      ops_per_sec: Number(info.instantaneous_ops_per_sec ?? 0),
      evicted_keys: Number(info.evicted_keys ?? 0),
      keyspace_hit_rate: hits + misses > 0 ? hits / (hits + misses) : null,
    };
  }

  app.get('/api/overview', async (c) => {
    const settle = async <T>(p: Promise<T>): Promise<T | { error: string }> =>
      p.catch((e: Error) => ({ error: e.message }));
    const [authS, chatS, billingS, stateInfo, cacheInfo, rawCache] = await Promise.all([
      settle(auth.get('/internal/stats')),
      settle(chat.get('/internal/stats')),
      settle(billing.get('/internal/stats')),
      settle(redisSummary(redis)),
      settle(redisSummary(cacheRedis)),
      redis.hgetall('metrics:cache').catch(() => ({}) as Record<string, string>),
    ]);

    // metrics:cache 欄位格式:{service}.{namespace}.{hit|miss|error|coalesced}
    const ns: Record<string, Record<string, number>> = {};
    for (const [field, v] of Object.entries(rawCache)) {
      const [service, name, kind] = field.split('.');
      const key = `${service}/${name}`;
      (ns[key] ??= {})[kind!] = Number(v);
    }
    const cache = Object.entries(ns).map(([name, k]) => {
      const hit = k.hit ?? 0;
      const total = hit + (k.miss ?? 0) + (k.coalesced ?? 0);
      return { name, ...k, hit_rate: total > 0 ? (hit + (k.coalesced ?? 0)) / total : null };
    });
    return c.json({ auth: authS, chat: chatS, billing: billingS, redis: { state: stateInfo, cache: cacheInfo }, cache });
  });

  // ---------------------------------------------------------------- 使用者 / 點數
  app.get('/api/users', async (c) => {
    const q = parse(
      z.object({ q: z.string().max(64).optional(), offset: z.coerce.number().int().min(0).default(0) }),
      c.req.query(),
    );
    const users = await auth.get<{ items: Array<{ id: string }> }>('/internal/users', {
      query: { q: q.q, limit: 50, offset: q.offset },
    });
    type Points = { balance: number; held: number; available: number };
    const empty: { items: Record<string, Points> } = { items: {} };
    const bal = await billing
      .post<{ items: Record<string, Points> }>('/internal/accounts/bulk', { user_ids: users.items.map((u) => u.id) })
      .catch(() => empty);
    return c.json({ items: users.items.map((u) => ({ ...u, points: bal.items[u.id] ?? null })) });
  });

  app.post('/api/users/:id/grant', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const b = parse(
      z.object({ amount: z.number().int().min(1).max(1_000_000), reason: z.string().max(100).default('客服補點') }),
      await readJson(c),
    );
    return c.json(await billing.post('/internal/grants', { user_id: id, amount: b.amount, reason: `[後台] ${b.reason}` }));
  });

  app.post('/api/users/:id/logout', async (c) => {
    return c.json(await auth.post(`/internal/users/${parse(uuid, c.req.param('id'))}/logout`));
  });

  app.get('/api/users/:id/ledger', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const before = c.req.query('before_id');
    return c.json(await billing.get('/internal/ledger', { query: { user_id: id, before_id: before, limit: 50 } }));
  });

  app.get('/api/users/:id/bookings', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    return c.json(await booking.get('/internal/bookings', { query: { user_id: id, limit: 30 } }));
  });

  app.get('/api/users/:id/conversations', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const [convs, chars] = await Promise.all([
      chat.get<{ items: Array<{ character_id: string }> }>('/internal/conversations', { query: { user_id: id } }),
      character.get<{ items: Array<{ id: string; name: string; avatar: string }> }>('/internal/characters'),
    ]);
    const byId = new Map(chars.items.map((x) => [x.id, x]));
    return c.json({
      items: convs.items.map((cv) => ({
        ...cv,
        character_name: byId.get(cv.character_id)?.name ?? '(已移除)',
        character_avatar: byId.get(cv.character_id)?.avatar ?? '',
      })),
    });
  });

  // ---------------------------------------------------------------- browser-use 開發執行紀錄(僅本機後台)
  async function traceManifest(id: string): Promise<{ trace: { manifest?: string; enabled?: boolean }; manifest: Record<string, unknown> }> {
    const detail = await booking.get<{ result?: { trace?: { manifest?: string; enabled?: boolean } } }>(`/internal/bookings/${id}`);
    const trace = detail.result?.trace;
    if (!trace?.enabled || !trace.manifest) throw Errors.notFound('此訂位沒有 browser agent 執行紀錄');
    // manifest 路徑只能是 worker 產生的 bookings/{booking-id}/{run-id}/manifest.json，不能信任 URL 參數。
    if (!new RegExp(`^bookings/${id}/[0-9a-f-]{36}/manifest\\.json$`).test(trace.manifest)) throw Errors.notFound('執行紀錄路徑無效');
    const file = resolve(artifactRoot, trace.manifest);
    if (relative(artifactRoot, file).startsWith(`..${sep}`)) throw Errors.notFound('執行紀錄路徑無效');
    const text = await Bun.file(file).text();
    if (!text) throw Errors.notFound('找不到執行紀錄');
    return { trace, manifest: JSON.parse(text) as Record<string, unknown> };
  }

  app.get('/api/bookings/:id/browser-trace', async (c) => c.json(await traceManifest(parse(uuid, c.req.param('id')))));

  app.get('/api/bookings/:id/browser-trace/screens/:sequence', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    const sequence = parse(z.coerce.number().int().min(1).max(1000), c.req.param('sequence'));
    const { trace, manifest } = await traceManifest(id);
    const shots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
    const shot = shots.find((v): v is { sequence: number; path: string } =>
      typeof v === 'object' && v !== null && (v as { sequence?: unknown }).sequence === sequence && typeof (v as { path?: unknown }).path === 'string',
    );
    if (!shot || !trace.manifest) throw Errors.notFound('找不到這一張截圖');
    const file = resolve(artifactRoot, trace.manifest, '..', shot.path);
    const runDir = resolve(artifactRoot, trace.manifest, '..');
    if (!/^screenshots\/\d{4}\.png$/.test(shot.path) || relative(runDir, file).startsWith(`..${sep}`)) throw Errors.notFound('截圖路徑無效');
    const image = Bun.file(file);
    if (!(await image.exists())) throw Errors.notFound('找不到截圖檔');
    return new Response(image, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  });

  app.get('/api/conversations/:id/messages', async (c) => {
    const id = parse(uuid, c.req.param('id'));
    return c.json(await chat.get(`/internal/conversations/${id}/messages`, { query: { before_seq: c.req.query('before_seq'), limit: 100 } }));
  });

  // ---------------------------------------------------------------- 角色
  app.get('/api/characters', async (c) => c.json(await character.get('/internal/characters')));
  app.post('/api/characters', async (c) => c.json(await character.post('/internal/characters', await readJson(c)), 201));
  app.put('/api/characters/:id', async (c) => {
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) throw Errors.notFound('角色不存在');
    return c.json(await character.put(`/internal/characters/${id}`, await readJson(c)));
  });

  const server = listen(envInt('PORT', 8090));
  log.info({ port: server.port }, 'admin listening');
  onShutdown(log, async () => {
    await server.stop();
    redis.disconnect();
    cacheRedis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
