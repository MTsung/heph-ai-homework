import { hostname } from 'node:os';
import { z } from 'zod';
import { buildApp, onShutdown } from '../../../shared/app';
import { ServiceClient } from '../../../shared/client';
import { channels, envInt, streams, urls } from '../../../shared/config';
import { createPool, migrate, waitForDb } from '../../../shared/db';
import { Errors, parse } from '../../../shared/errors';
import { StreamConsumer } from '../../../shared/events';
import { CacheStats, createRedis, subscribe } from '../../../shared/redis';
import { CharacterDirectory } from './characters';
import { createMetrics, genStreamKey, llmHooks, lockKey, loadConfig, type Deps } from './deps';
import { GenerationManager } from './generation';
import { createLlm, Semaphore } from '../../../shared/llm';
import { migrations } from './migrations';
import { Reaper } from './reaper';
import { RecentCache } from './recent';
import { registerRoutes, toDto } from './routes';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool('chat');
  const redis = createRedis('chat'); // state:鎖、串流續傳、事件 Stream
  const cacheRedis = createRedis('chat', 'cache'); // cache:最近訊息
  const { app, log, registry, listen } = buildApp({
    service: 'chat',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  });

  await waitForDb(pool);
  await migrate(pool, 'chat', migrations);

  const stats = new CacheStats(redis, 'chat');
  stats.start();
  const metrics = createMetrics(registry);
  // 工廠依 LLM_PROVIDERS 建立供應商鏈(缺少金鑰、名稱打錯會在這裡直接啟動失敗,不會等到有人聊天才發現)
  const provider = createLlm(llmHooks(metrics), log);
  log.info(
    { chain: provider.status().map((s) => `${s.name}(${s.model})`), maxOutputTokens: cfg.maxOutputTokens },
    'llm provider chain ready',
  );

  const d: Deps = {
    pool,
    redis,
    recent: new RecentCache(cacheRedis, pool, stats, log, cfg.recentSize, cfg.recentTtlSec),
    billing: new ServiceClient('billing', urls.billing(), 5000),
    directory: new CharacterDirectory(new ServiceClient('character', urls.character(), 3000)),
    provider,
    llmSem: new Semaphore(envInt('LLM_MAX_CONCURRENCY', provider.name === 'mock' ? 100_000 : 64)),
    log,
    metrics,
    cfg,
  };

  const manager = new GenerationManager(d);
  let draining = false;
  registerRoutes(app, d, manager, () => draining);

  // 角色資料被修改 → 清掉本機快取
  const charSub = subscribe(redis, channels.characterEvents, (msg) => {
    try {
      d.directory.invalidate((JSON.parse(msg) as { id: string | null }).id);
    } catch {
      d.directory.invalidate();
    }
  });

  const reaper = new Reaper(d);
  reaper.start();

  // ======================================================================= 刪除帳號(冪等)
  const consumer = new StreamConsumer(
    redis,
    streams.userEvents,
    'chat',
    `chat-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      manager.abortUser(userId); // 先中止這位使用者進行中的生成
      const { rows: convs } = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE user_id = $1', [userId]);
      // 分批刪除,避免一個超大 transaction 長時間鎖表
      for (;;) {
        const r = await pool.query('DELETE FROM messages WHERE ctid IN (SELECT ctid FROM messages WHERE user_id = $1 LIMIT 5000)', [userId]);
        if (!r.rowCount) break;
      }
      await pool.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
      for (const c of convs) {
        await d.recent.invalidate(c.id);
        await redis.del(lockKey(c.id)).catch(() => undefined);
      }
      log.info({ userId, conversations: convs.length }, 'chat data deleted for user');
    },
    log,
  );
  await consumer.start();

  // ======================================================================= 內部 API(admin 使用)
  app.get('/internal/conversations', async (c) => {
    const q = parse(
      z.object({
        user_id: z.string().uuid(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      c.req.query(),
    );
    const { rows } = await pool.query(
      `SELECT id, user_id, character_id, last_message_at, last_preview, next_seq - 1 AS latest_seq, created_at
         FROM conversations WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT $2`,
      [q.user_id, q.limit],
    );
    return c.json({ items: rows });
  });

  app.get('/internal/conversations/:id/messages', async (c) => {
    const id = parse(z.string().uuid(), c.req.param('id'));
    const q = parse(
      z.object({
        before_seq: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      c.req.query(),
    );
    const { rows } = await pool.query(
      `SELECT id, conversation_id, seq, role, content, status, error_code, attempt, cost, billing_state,
              model, provider, input_tokens, output_tokens, created_at
         FROM messages WHERE conversation_id = $1 AND ($2::int IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [id, q.before_seq ?? null, q.limit],
    );
    return c.json({ items: rows.reverse() });
  });

  app.get('/internal/stats', async (c) => {
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM conversations) AS conversations,
              (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM messages WHERE status = 'streaming') AS streaming_now,
              (SELECT count(*) FROM messages WHERE status = 'failed') AS failed_total,
              (SELECT count(*) FROM messages WHERE billing_state IN ('settle_pending','release_pending')) AS billing_pending`,
    );
    return c.json({
      ...Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)])),
      active_generations_this_instance: manager.activeCount,
      // 各供應商的健康狀態(只代表回應這次請求的這一個 instance)
      llm: provider.status(),
    });
  });

  /** 診斷用:看某則 AI 訊息在 Redis 的串流進度(除錯續傳時使用)。 */
  app.get('/internal/debug/stream/:mid', async (c) => {
    const mid = parse(z.string().uuid(), c.req.param('mid'));
    const entries = await redis.xrange(genStreamKey(mid), '-', '+');
    return c.json({ entries: entries.length, local: !!manager.get(mid) });
  });

  app.get('/internal/message/:mid', async (c) => {
    const mid = parse(z.string().uuid(), c.req.param('mid'));
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [mid]);
    if (!rows[0]) throw Errors.notFound('找不到訊息');
    return c.json({
      ...toDto(rows[0]),
      billing_state: rows[0].billing_state,
      attempt: rows[0].attempt,
      hold_ref: rows[0].hold_ref,
      // 實際由哪個供應商/模型回覆,以及用了多少 token(成本對帳用)
      model: rows[0].model,
      provider: rows[0].provider,
      input_tokens: rows[0].input_tokens,
      output_tokens: rows[0].output_tokens,
    });
  });

  const server = listen(envInt('PORT', 3003));
  log.info({ port: server.port, maxActive: cfg.maxActive }, 'chat listening');

  onShutdown(
    log,
    async () => {
      // 滾動更新時:先宣告 draining(新請求收到 503,由上游改打別台),
      // 再讓進行中的回覆自然結束,逾時才強制中止(中止的回覆會標記失敗並歸還點數)。
      draining = true;
      reaper.stop();
      await manager.drain(envInt('DRAIN_WAIT_MS', 20_000));
      await server.stop();
      await consumer.stop();
      charSub.disconnect();
      stats.stop();
      await stats.flush();
      await pool.end();
      redis.disconnect();
      cacheRedis.disconnect();
    },
    envInt('SHUTDOWN_TIMEOUT_MS', 28_000),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
