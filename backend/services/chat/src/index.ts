import { buildApp, onShutdown } from '@chat-app/shared/app';
import { ServiceClient } from '@chat-app/shared/client';
import { channels, envInt, urls } from '@chat-app/shared/config';
import { createPool, migrate, waitForDb } from '@chat-app/shared/db';
import { createLlm, Semaphore } from '@chat-app/shared/llm';
import { CacheStats, createRedis, subscribe } from '@chat-app/shared/redis';
import { ConversationIndex } from './cache/conversation-index';
import { RecentMessagesCache } from './cache/recent-messages.cache';
import { BillingClient } from './clients/billing.client';
import { CharacterDirectory } from './clients/character.client';
import { loadConfig } from './config';
import { userDeletedConsumer } from './consumers/user-deleted.consumer';
import { migrations } from './db/migrations';
import { ContextBuilder } from './generation/context-builder';
import { GenerationLock } from './generation/generation-lock';
import { GenerationManager } from './generation/generation-manager';
import { GenerationStreamStore } from './generation/stream-store';
import { ReaperJob } from './jobs/reaper.job';
import { createMetrics, llmHooks } from './metrics';
import { ConversationRepository } from './repositories/conversation.repository';
import { MessageRepository } from './repositories/message.repository';
import { conversationRoutes } from './routes/conversations.routes';
import { internalRoutes } from './routes/internal.routes';
import { ConversationService } from './services/conversation.service';
import { InspectionService } from './services/inspection.service';
import { MessageService } from './services/message.service';
import { SettlementService } from './services/settlement.service';
import { MessageStreamer } from './streaming/message-streamer';

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

  // ---- 組裝:repositories → clients / cache → generation → services
  const messageRepo = new MessageRepository(pool);
  const conversationRepo = new ConversationRepository(pool);
  const directory = new CharacterDirectory(new ServiceClient('character', urls.character(), 3000));
  const billing = new BillingClient(new ServiceClient('billing', urls.billing(), 5000));
  const recent = new RecentMessagesCache(cacheRedis, messageRepo, conversationRepo, stats, log, cfg.recentSize, cfg.recentTtlSec);
  const lock = new GenerationLock(redis, cfg.lockTtlMs);
  const streamStore = new GenerationStreamStore(redis);
  const settlement = new SettlementService(pool, billing, directory, log, metrics);

  const manager = new GenerationManager({
    messages: messageRepo,
    recent,
    settlement,
    lock,
    streamStore,
    provider,
    llmSem: new Semaphore(envInt('LLM_MAX_CONCURRENCY', provider.name === 'mock' ? 100_000 : 64)),
    log,
    metrics,
    cfg,
  });

  let draining = false;
  const conversations = new ConversationService(pool, directory);
  const messages = new MessageService({
    messages: messageRepo,
    conversations: conversationRepo,
    index: new ConversationIndex(conversationRepo),
    recent,
    directory,
    billing,
    settlement,
    lock,
    manager,
    context: new ContextBuilder(recent, cfg),
    defaultModel: () => provider.defaultModel,
    cfg,
    isDraining: () => draining,
  });
  const streamer = new MessageStreamer(manager, messageRepo, streamStore, log);
  const inspection = new InspectionService(conversationRepo, messageRepo, manager, streamStore, provider);

  // ---- 路由
  app.route('/', conversationRoutes({ conversations, messages, streamer, userMessageMaxChars: cfg.userMessageMaxChars }));
  app.route('/', internalRoutes({ inspection }));

  // ---- 背景任務與事件
  // 角色資料被修改 → 清掉本機快取
  const charSub = subscribe(redis, channels.characterEvents, (msg) => {
    try {
      directory.invalidate((JSON.parse(msg) as { id: string | null }).id);
    } catch {
      directory.invalidate();
    }
  });

  const reaper = new ReaperJob({ pool, lock, streamStore, recent, settlement, log, metrics });
  reaper.start();

  const consumer = userDeletedConsumer(redis, { manager, conversations, recent, lock, log });
  await consumer.start();

  // ---- 啟動與關閉
  const server = listen(cfg.port);
  log.info({ port: server.port, maxActive: cfg.maxActive }, 'chat listening');

  onShutdown(
    log,
    async () => {
      // 滾動更新時:先宣告 draining,並「立刻停止接受新連線」(Bun 的 stop() 不會中斷進行中的請求與 SSE),
      // 之後的新請求會得到 ECONNREFUSED,gateway 確定它們沒被處理、可以安全地換另一台重送。
      // 如果等 drain 結束才 stop,drain 的 20 秒內仍會有新連線被接受、卻在關閉時被丟掉,gateway 只能等到逾時。
      // 再讓進行中的回覆自然結束,逾時才強制中止(中止的回覆會標記失敗並歸還點數)。
      draining = true;
      reaper.stop();
      await server.stop();
      await manager.drain(cfg.drainWaitMs);
      await consumer.stop();
      charSub.disconnect();
      stats.stop();
      await stats.flush();
      await pool.end();
      redis.disconnect();
      cacheRedis.disconnect();
    },
    cfg.shutdownTimeoutMs,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
