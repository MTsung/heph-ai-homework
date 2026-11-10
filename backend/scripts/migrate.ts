// migration 管理:查看狀態、倒退。往前套用不在這裡 —— 服務啟動時會自動執行。
//
//   bun scripts/migrate.ts status [服務]            各服務 migration 的套用狀態(不指定 = 全部)
//   bun scripts/migrate.ts down <服務> [--steps N]   倒退最後 N 個(預設 1)已套用的 migration
//
// 服務:auth / chat / billing / character / booking
//
// 連線:DATABASE_URL_<服務大寫> > 用 PG_HOST(預設 postgres)、POSTGRES_USER(預設 chatapp)、POSTGRES_PASSWORD(預設 chatapp)組成 postgres://…/<服務>
// 倒退在 NODE_ENV=production 預設拒絕,要設 ALLOW_MIGRATE_DOWN=1。
// 注意:要用「含有這個 migration 的版本」的 image 執行,舊版本的程式裡沒有它的 down。release.sh migrate 會處理。
import { createPool, migrateDown, migrationStatus, type Migration } from '../shared/db';
import { migrations as auth } from '../services/auth/src/migrations';
import { migrations as billing } from '../services/billing/src/migrations';
import { migrations as character } from '../services/character/src/migrations';
import { migrations as chat } from '../services/chat/src/migrations';
import { migrations as booking } from '../booking/services/booking/src/migrations';

const SERVICES: Record<string, Migration[]> = { auth, chat, billing, character, booking };

function url(service: string): string {
  const own = process.env[`DATABASE_URL_${service.toUpperCase()}`];
  if (own) return own;
  const host = process.env.PG_HOST ?? 'postgres';
  const user = process.env.POSTGRES_USER ?? 'chatapp';
  const pw = process.env.POSTGRES_PASSWORD ?? 'chatapp';
  return `postgres://${user}:${encodeURIComponent(pw)}@${host}:5432/${service}`;
}

async function withPool<T>(service: string, fn: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = url(service); // createPool 讀這個
  const pool = createPool(`migrate-${service}`);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const [cmd, svc, ...rest] = process.argv.slice(2);

  if (cmd === 'status') {
    const names = svc ? [svc] : Object.keys(SERVICES);
    for (const name of names) {
      const list = SERVICES[name];
      if (!list) throw new Error(`未知的服務:${name}(可用:${Object.keys(SERVICES).join(', ')})`);
      const rows = await withPool(name, (pool) => migrationStatus(pool, list));
      console.log(`\n${name}`);
      for (const r of rows) {
        console.log(`  ${r.applied ? '已套用' : '未套用'}  ${r.id.padEnd(28)} ${r.hasDown ? 'down:有' : 'down:無'}`);
      }
    }
    return;
  }

  if (cmd === 'down') {
    if (!svc || !SERVICES[svc]) throw new Error(`用法:down <服務> [--steps N]。可用服務:${Object.keys(SERVICES).join(', ')}`);
    const i = rest.indexOf('--steps');
    const steps = i >= 0 ? Number(rest[i + 1]) : 1;
    const done = await withPool(svc, (pool) => migrateDown(pool, svc, SERVICES[svc]!, steps));
    console.log(done.length ? `已倒退(由後往前):${done.join(', ')}` : '沒有可倒退的 migration。');
    return;
  }

  console.log('用法:\n  bun scripts/migrate.ts status [服務]\n  bun scripts/migrate.ts down <服務> [--steps N]');
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(`錯誤:${(e as Error).message}`);
  process.exit(1);
});
