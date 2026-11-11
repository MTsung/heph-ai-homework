import { buildApp, onShutdown } from '@chat-app/shared/app';
import { envInt } from '@chat-app/shared/config';
import { createPool, migrate, waitForDb } from '@chat-app/shared/db';
import { CacheAside, CacheStats, createRedis } from '@chat-app/shared/redis';
import { migrations } from './db/migrations';
import { CharacterRepository } from './repositories/character.repository';
import { characterRoutes } from './routes/character.routes';
import { internalRoutes } from './routes/internal.routes';
import { CharacterService } from './services/character.service';

const CACHE_TTL_SEC = envInt('CHARACTER_CACHE_TTL_SEC', 600);

async function main(): Promise<void> {
  const pool = createPool('character');
  const redis = createRedis('character'); // state:pub/sub、統計
  const cacheRedis = createRedis('character', 'cache'); // cache:角色資料
  const { app, log, listen } = buildApp({
    service: 'character',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
      await cacheRedis.ping();
    },
  });
  const stats = new CacheStats(redis, 'character');
  stats.start();

  await waitForDb(pool);
  await migrate(pool, 'character', migrations);

  // ---- 組裝
  const characters = new CharacterService(
    new CharacterRepository(pool),
    new CacheAside(cacheRedis, 'char', stats, log),
    redis,
    CACHE_TTL_SEC,
  );
  await characters.seedDefaults();

  // ---- 路由
  app.route('/', characterRoutes({ characters }));
  app.route('/', internalRoutes({ characters }));

  // ---- 啟動與關閉
  const server = listen(envInt('PORT', 3002));
  log.info({ port: server.port }, 'character listening');
  onShutdown(log, async () => {
    stats.stop();
    await stats.flush();
    await server.stop();
    await pool.end();
    redis.disconnect();
    cacheRedis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
