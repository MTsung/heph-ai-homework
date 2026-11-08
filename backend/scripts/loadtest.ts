// 壓測與驗證腳本(在 compose 網路內執行,才摸得到內部服務):
//   docker compose --profile tools run --rm tools bun scripts/loadtest.ts streams 500
//   docker compose --profile tools run --rm tools bun scripts/loadtest.ts holds 300
//   docker compose --profile tools run --rm tools bun scripts/loadtest.ts history 400
//
// 壓測前請放寬 gateway 限流(否則註冊會被 429 擋下):
//   RL_AUTH_PER_IP_PER_MIN=100000 RL_SEND_PER_USER_PER_MIN=100000 RL_USER_PER_MIN=1000000 docker compose up -d gateway
export {}; // 讓此檔成為獨立的 module,避免與其他腳本的頂層宣告衝突
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const BILLING = process.env.BILLING_URL ?? 'http://billing:3004';
const CHAT = process.env.CHAT_URL ?? 'http://chat:3003';
const INTERNAL = process.env.INTERNAL_TOKEN ?? 'dev-internal-token-change-me';
const REDIS_CACHE = process.env.REDIS_CACHE_URL ?? 'redis://redis-cache:6379';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const ms = (n: number) => `${n.toFixed(0)}ms`;

async function pool<T>(items: number, concurrency: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(items);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items) return;
        out[i] = await fn(i);
      }
    }),
  );
  return out;
}

async function json(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function register(prefix: string, i: number) {
  const r = await json('POST', `${GATEWAY}/v1/auth/register`, {}, {
    username: `${prefix}_${i}`,
    password: 'loadtest1',
    device_id: `lt-${i}`,
    device_name: 'LoadTest',
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.token as string, userId: r.json.user.id as string };
}

async function metric(url: string, name: string): Promise<number> {
  const res = await fetch(`${url}/metrics`, { headers: { 'x-internal-token': INTERNAL } });
  const t = await res.text();
  const line = t.split('\n').find((l) => l.startsWith(name) && !l.startsWith('#'));
  return line ? Number(line.split(' ').pop()) : NaN;
}

// ============================================================================
// 場景 1:N 個使用者「同時」各開一條 SSE 串流
// ============================================================================
async function streams(n: number) {
  const prefix = `lt${Date.now().toString(36)}`;
  console.log(`\n▶ 場景:${n} 位使用者同時串流聊天\n`);

  console.log('  準備:註冊並建立對話…');
  const t0 = performance.now();
  const chars = (await json('GET', `${GATEWAY}/v1/characters`, { authorization: `Bearer ${(await register(prefix, 999999)).token}` })).json.items;
  const users = await pool(n, 40, async (i) => {
    const u = await register(prefix, i);
    const ch = chars[i % chars.length];
    const c = await json('POST', `${GATEWAY}/v1/conversations`, { authorization: `Bearer ${u.token}` }, { character_id: ch.id });
    return { ...u, convId: c.json.id as string, price: ch.price as number };
  });
  console.log(`  準備完成,${n} 位使用者,耗時 ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

  const rssBefore = {
    gateway: await metric(GATEWAY, 'process_resident_memory_bytes').catch(() => NaN),
    chat: await metric(CHAT, 'process_resident_memory_bytes'),
  };

  // 取樣 chat 的「進行中串流數」找尖峰。注意:每次抓 /metrics 都會觸發 prom-client 收集預設指標
  // (heapStats、掃 /proc),本身就吃 CPU,會干擾被測的服務。所以取樣間隔放寬到 1 秒,
  // 並可用 SAMPLE=0 完全關閉(量測延遲/吞吐的正式數據請關閉)。
  let peak = 0;
  let sampling = process.env.SAMPLE !== '0';
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, (await metric(CHAT, 'chat_active_generations').catch(() => 0)) || 0);
      await sleep(1000);
    }
  })();

  const ttft: number[] = [];
  const total: number[] = [];
  const results = { ok: 0, failed: 0, status: {} as Record<string, number> };
  const start = performance.now();

  // 到達模式:RATE > 0 → 以固定速率(每秒 RATE 個新請求)到達,模擬真實流量;
  //          RATE = 0 → 全部同一瞬間齊發(最壞情況的瞬間尖峰)。
  const rate = Number(process.env.RATE ?? 0);
  console.log(`  到達模式:${rate > 0 ? `每秒 ${rate} 個新請求` : '全部同一瞬間齊發'}\n`);

  await Promise.all(
    users.map(async (u, idx) => {
      if (rate > 0) await sleep((idx / rate) * 1000);
      const s = performance.now();
      let first = 0;
      try {
        const res = await fetch(`${GATEWAY}/v1/conversations/${u.convId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${u.token}` },
          body: JSON.stringify({ content: '你好,今天心情有點累', client_msg_id: crypto.randomUUID() }),
        });
        if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
          results.failed++;
          results.status[String(res.status)] = (results.status[String(res.status)] ?? 0) + 1;
          await res.text();
          return;
        }
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let done = false;
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          if (!first && buf.includes('event: delta')) first = performance.now() - s;
          if (buf.includes('event: done')) done = true;
        }
        if (done) {
          results.ok++;
          ttft.push(first);
          total.push(performance.now() - s);
        } else {
          results.failed++;
          results.status['no-done'] = (results.status['no-done'] ?? 0) + 1;
        }
      } catch (e) {
        results.failed++;
        results.status[(e as Error).message.slice(0, 40)] = (results.status[(e as Error).message.slice(0, 40)] ?? 0) + 1;
      }
    }),
  );
  const wall = (performance.now() - start) / 1000;
  sampling = false;
  await sampler;

  const rssAfter = {
    gateway: await metric(GATEWAY, 'process_resident_memory_bytes').catch(() => NaN),
    chat: await metric(CHAT, 'process_resident_memory_bytes'),
  };
  const mb = (b: number) => (Number.isNaN(b) ? 'n/a' : `${(b / 1048576).toFixed(0)}MB`);

  console.log('  ┌─ 結果 ──────────────────────────────────────────');
  console.log(`  │ 成功 ${results.ok} / ${n}    失敗 ${results.failed} ${JSON.stringify(results.status)}`);
  console.log(`  │ chat 同時進行中的串流尖峰:${peak}`);
  console.log(`  │ 首字延遲 TTFT   p50 ${ms(pct(ttft, 50))}  p95 ${ms(pct(ttft, 95))}  p99 ${ms(pct(ttft, 99))}  max ${ms(Math.max(...ttft))}`);
  console.log(`  │ 完整回覆耗時    p50 ${ms(pct(total, 50))}  p95 ${ms(pct(total, 95))}  p99 ${ms(pct(total, 99))}`);
  console.log(`  │ 總牆鐘時間 ${wall.toFixed(1)}s,平均吞吐 ${(results.ok / wall).toFixed(0)} 則回覆/秒`);
  console.log(`  │ 記憶體 chat ${mb(rssBefore.chat)} → ${mb(rssAfter.chat)};gateway ${mb(rssBefore.gateway)} → ${mb(rssAfter.gateway)}`);
  console.log('  └─────────────────────────────────────────────────');

  // 一致性核對:每位使用者 200 點,成功一則扣「該角色的單價」;預扣必須全部歸零
  await sleep(1500);
  let bad = 0;
  let held = 0;
  await pool(users.length, 40, async (i) => {
    const b = (await json('GET', `${GATEWAY}/v1/points/balance`, { authorization: `Bearer ${users[i]!.token}` })).json;
    held += b.held;
    if (b.balance !== 200 - users[i]!.price) bad++;
  });
  console.log(`  點數核對:餘額 ≠ 200 − 角色單價 的使用者 ${bad} 位;殘留預扣總和 ${held}   ${bad === 0 && held === 0 ? '✅' : '❌'}`);
}

// ============================================================================
// 場景 2:同一個帳戶被大量並發預扣 → 不可超扣
// ============================================================================
async function holds(p: number) {
  console.log(`\n▶ 場景:${p} 個並發預扣搶同一個帳戶(餘額 200 點,每次預扣 1 點)\n`);
  const u = await register(`hold${Date.now().toString(36)}`, 0);
  const H = { 'x-internal-token': INTERNAL };
  const t0 = performance.now();
  const out = await pool(p, p, (i) =>
    json('POST', `${BILLING}/internal/holds`, H, { ref: `race-${u.userId}-${i}`, user_id: u.userId, amount: 1 }).then((r) => r.status),
  );
  const wall = performance.now() - t0;
  const okN = out.filter((s) => s === 200).length;
  const rejected = out.filter((s) => s === 402).length;
  const other = out.length - okN - rejected;
  const acct = (await json('GET', `${BILLING}/internal/accounts/${u.userId}`, H)).json;
  console.log(`  成功 ${okN}、點數不足(402) ${rejected}、其他 ${other}    耗時 ${ms(wall)}`);
  console.log(`  帳戶:balance=${acct.balance} held=${acct.held} available=${acct.available}`);
  const pass = okN === 200 && rejected === p - 200 && acct.held === 200 && acct.available === 0 && other === 0;
  console.log(`  ${pass ? '✅ 恰好 200 個成功,沒有超扣,可用點數為 0' : '❌ 與預期不符'}`);

  // 同一個 ref 並發重送 → 只能預扣一次
  const ref = `idem-${u.userId}`;
  const u2 = await register(`hold${Date.now().toString(36)}`, 1);
  const dup = await pool(50, 50, () => json('POST', `${BILLING}/internal/holds`, H, { ref, user_id: u2.userId, amount: 5 }).then((r) => r.status));
  const acct2 = (await json('GET', `${BILLING}/internal/accounts/${u2.userId}`, H)).json;
  console.log(`  同一個 ref 並發重送 50 次:狀態碼 ${[...new Set(dup)].join(',')};held=${acct2.held}  ${acct2.held === 5 ? '✅ 只預扣一次' : '❌'}`);
}

// ============================================================================
// 場景 3:歷史訊息第一頁,快取 vs 直接查 DB
// ============================================================================
async function history(m: number) {
  console.log(`\n▶ 場景:讀取最新一頁歷史(${m} 次,序列),快取命中 vs 每次作廢快取\n`);
  const Redis = (await import('ioredis')).default;
  const cache = new Redis(REDIS_CACHE);
  const u = await register(`hist${Date.now().toString(36)}`, 0);
  const auth = { authorization: `Bearer ${u.token}` };
  const chars = (await json('GET', `${GATEWAY}/v1/characters`, auth)).json.items;
  const conv = (await json('POST', `${GATEWAY}/v1/conversations`, auth, { character_id: chars[0].id })).json;
  // 聊幾輪,讓對話有內容
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${GATEWAY}/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: `第 ${i} 輪訊息`, client_msg_id: crypto.randomUUID() }),
    });
    await r.text();
  }
  const url = `${GATEWAY}/v1/conversations/${conv.id}/messages?limit=30`;
  await fetch(url, { headers: auth }).then((r) => r.text()); // 暖機

  const warm: number[] = [];
  for (let i = 0; i < m; i++) {
    const s = performance.now();
    await fetch(url, { headers: auth }).then((r) => r.text());
    warm.push(performance.now() - s);
  }
  const cold: number[] = [];
  for (let i = 0; i < m; i++) {
    await cache.del(`recent:${conv.id}`);
    const s = performance.now();
    await fetch(url, { headers: auth }).then((r) => r.text());
    cold.push(performance.now() - s);
  }
  const f = (n: number) => n.toFixed(2) + 'ms';
  console.log(`  快取命中   p50 ${f(pct(warm, 50))}  p95 ${f(pct(warm, 95))}  p99 ${f(pct(warm, 99))}`);
  console.log(`  快取作廢   p50 ${f(pct(cold, 50))}  p95 ${f(pct(cold, 95))}  p99 ${f(pct(cold, 99))}   (每次都要回源重建)`);
  cache.disconnect();
}

const [scenario = 'streams', arg] = process.argv.slice(2);
const n = Number(arg ?? 0);
if (scenario === 'streams') await streams(n || 500);
else if (scenario === 'holds') await holds(n || 300);
else if (scenario === 'history') await history(n || 400);
else console.log('用法:loadtest.ts <streams|holds|history> [N]');
process.exit(0);
