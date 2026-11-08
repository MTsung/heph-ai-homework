// 驗證 LLM 工廠、備援與成本控制(搭配 fake-llm,不需要真實金鑰)。在專案根目錄執行:
//
//   E=backend/scripts/llm-check.env
//   docker compose --env-file $E --profile tools up -d --build fake-llm chat gateway
//   docker compose --env-file $E --profile tools run --rm --no-deps tools bun scripts/llm-check.ts
//
// 做完請還原成正常設定:  docker compose up -d chat gateway
// (--env-file 會取代專案根目錄的 .env,所以不加這個參數的 `up` 就是回到你原本的設定。)
//
// 涵蓋:主要正常 / 送出的請求內容(成本控制)/ 輸入上限 / 503·429·400·空回覆·卡住 時換備援 /
//       斷路器開路與恢復 / 兩家都壞 → 「目前系統有問題」且不扣點 / 不該換手的情境 / token 用量記錄。
export {};
const G = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const FAKE = process.env.FAKE_LLM_URL ?? 'http://fake-llm:9000';
const CHAT = process.env.CHAT_URL ?? 'http://chat:3003';
const INTERNAL = process.env.INTERNAL_TOKEN ?? 'dev-internal-token-change-me';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

const fake = {
  mode: (m: Partial<Record<'gemini' | 'openai', string>>) => fetch(`${FAKE}/control`, { method: 'POST', body: JSON.stringify(m) }).then((r) => r.json()),
  state: () => fetch(`${FAKE}/state`).then((r) => r.json()) as Promise<any>,
  reset: () => fetch(`${FAKE}/reset`, { method: 'POST' }),
  resetCounts: () => fetch(`${FAKE}/reset-counts`, { method: 'POST' }),
};

async function j(method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(`${G}/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

interface Ev { event: string; data: any }
async function send(token: string, conv: string, content: string, cmid = crypto.randomUUID()): Promise<{ status: number; events: Ev[]; ms: number; err?: any }> {
  const t0 = performance.now();
  const r = await fetch(`${G}/v1/conversations/${conv}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ content, client_msg_id: cmid }) });
  if (!(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: r.status, events: [], ms: performance.now() - t0, err: await r.json().catch(() => null) };
  const text = await r.text();
  const events = text.split('\n\n').map((b) => {
    const ev: Ev = { event: 'message', data: null };
    for (const l of b.split('\n')) {
      if (l.startsWith('event:')) ev.event = l.slice(6).trim();
      else if (l.startsWith('data:')) { try { ev.data = JSON.parse(l.slice(5).trim()); } catch {} }
    }
    return ev;
  }).filter((e) => e.data !== null);
  return { status: r.status, events, ms: performance.now() - t0 };
}
const reply = (evs: Ev[]) => evs.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
const done = (evs: Ev[]) => evs.find((e) => e.event === 'done')?.data;
const error = (evs: Ev[]) => evs.find((e) => e.event === 'error')?.data;

async function newUser() {
  const name = `lc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const r = await j('POST', '/auth/register', undefined, { username: name, password: 'secret123', device_id: 'd', device_name: 'd' });
  if (r.status !== 201) throw new Error(`註冊失敗 ${r.status} ${JSON.stringify(r.json)}`);
  const token = r.json.token as string;
  const chars = await j('GET', '/characters', token);
  if (chars.status !== 200) throw new Error(`取得角色失敗 ${chars.status} ${JSON.stringify(chars.json)}`);
  const ch = chars.json.items[0];
  const conv = (await j('POST', '/conversations', token, { character_id: ch.id })).json.id as string;
  return { token, conv, price: ch.price as number, name };
}
const balance = async (t: string) => (await j('GET', '/points/balance', t)).json;
const chatStats = async () => (await (await fetch(`${CHAT}/internal/stats`, { headers: { 'x-internal-token': INTERNAL } })).json()) as any;
const metrics = async () => (await (await fetch(`${CHAT}/metrics`, { headers: { 'x-internal-token': INTERNAL } })).text());
// prom-client 會在標籤尾端多一個 service="chat",所以用「前綴 + 逐一包含」的方式比對,而不是整段正規表示式
const metricVal = (txt: string, name: string, labels: Record<string, string>) =>
  Number(
    txt
      .split('\n')
      .find((l) => l.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
      ?.split(' ')
      .pop() ?? 0,
  );

console.log('\n=== LLM 工廠 / 備援 / 成本控制 驗證 ===\n');
const st0 = await chatStats();
console.log('供應商鏈:', st0.llm.map((s: any) => `${s.name}(${s.model})`).join(' → '), '\n');
check('工廠依 LLM_PROVIDERS 建出 gemini → groq 兩層鏈', st0.llm.length === 2 && st0.llm[0].name === 'gemini' && st0.llm[1].name === 'groq');

// ---------------------------------------------------------------- 1. 主要正常
console.log('\n— 1. 主要供應商正常');
await fake.reset();
let u = await newUser();
let r = await send(u.token, u.conv, '你好,今天心情有點累');
check('由 Gemini 回覆,串流完整', !!done(r.events) && reply(r.events) === done(r.events).message.content && reply(r.events).length > 0, reply(r.events));
let s = await fake.state();
check('只呼叫了 Gemini,沒有動到備援', s.calls.gemini === 1 && s.calls.openai === 0, JSON.stringify(s.calls));
let b = await balance(u.token);
check(`扣點一次 (${u.price})`, b.balance === 200 - u.price && b.held === 0, JSON.stringify(b));

// ---------------------------------------------------------------- 2. 成本控制:我們實際送給 Gemini 的請求
console.log('\n— 2. 成本控制:實際送出的請求內容');
const gem = s.last.gemini;
const body = gem.body;
check('金鑰放在 x-goog-api-key 標頭,不在網址', gem.apiKeyHeader === 'fake-gemini-key' && gem.keyInUrl === false, `header=${gem.apiKeyHeader} keyInUrl=${gem.keyInUrl}`);
check('使用串流端點 alt=sse', gem.query.includes('alt=sse') && gem.path.endsWith(':streamGenerateContent'), gem.path + gem.query);
check('輸出 token 上限 maxOutputTokens=300', body.generationConfig.maxOutputTokens === 300, String(body.generationConfig.maxOutputTokens));
check('關閉思考 thinkingBudget=0 (思考以輸出價計費)', body.generationConfig.thinkingConfig?.thinkingBudget === 0, JSON.stringify(body.generationConfig.thinkingConfig));
check('人設走 systemInstruction', !!body.systemInstruction?.parts?.[0]?.text?.includes('小曦'));
check('contents 不以 model 開頭 (Gemini 規定),且角色只有 user/model', body.contents[0].role === 'user' && body.contents.every((c: any) => c.role === 'user' || c.role === 'model'), body.contents.map((c: any) => c.role).join(','));
check('contents 沒有相鄰同角色', body.contents.every((c: any, i: number) => i === 0 || c.role !== body.contents[i - 1].role));

// 長歷史:輸入要被截斷
console.log('\n— 3. 成本控制:輸入上限(歷史變長也不會無限增加)');
await fake.reset();
u = await newUser();
for (let i = 0; i < 9; i++) await send(u.token, u.conv, `第 ${i} 輪,${'很長的訊息'.repeat(60)}`.slice(0, 480));
await fake.reset();
await send(u.token, u.conv, '最後一則');
s = await fake.state();
const sent = s.last.gemini.body.contents;
const totalChars = sent.reduce((a: number, c: any) => a + c.parts[0].text.length, 0);
check(`歷史已有約 19 則,送出的 contents 被限制 (≤ 12 則歷史 + 目前這則)`, sent.length <= 14, `${sent.length} 個 turn`);
check('總字元不超過上限 (2500 + 目前訊息)', totalChars <= 2500 + 100, `${totalChars} 字`);
const maxMsg = Math.max(...sent.map((c: any) => c.parts[0].text.length));
check('單則歷史不超過 400 字 (+ 合併相鄰同角色)', maxMsg <= 400 * 2 + 5, `最長 ${maxMsg} 字`);
const longTry = await send(u.token, u.conv, 'x'.repeat(501));
check('使用者單則超過 500 字 → 400,沒有打到模型', longTry.status === 400 && (await fake.state()).calls.gemini === 1, JSON.stringify(longTry.err?.error));

// ---------------------------------------------------------------- 4. 備援
console.log('\n— 4. 備援:Gemini 壞掉 → 自動換 Groq');
for (const mode of ['503', '429', '400', 'empty', 'hang']) {
  await fake.reset();
  await sleep(100);
  // 重置斷路器狀態:每個情境都用新的失敗計數(等冷卻 + 讓探測成功)
  await fake.mode({ gemini: 'ok' });
  await waitBreakerClosed();
  await fake.mode({ gemini: mode });
  u = await newUser();
  await fake.resetCounts(); // 只清計數(不動模式),避免 newUser/waitBreakerClosed 的探測污染受測請求的次數
  r = await send(u.token, u.conv, '你好');
  s = await fake.state();
  const ok = !!done(r.events) && reply(r.events).length > 0;
  b = await balance(u.token);
  check(`Gemini=${mode.padEnd(5)} → 換 Groq 成功回覆,扣點一次`, ok && s.calls.gemini === 1 && s.calls.openai === 1 && b.balance === 200 - u.price, `${Math.round(r.ms)}ms, gemini ${s.calls.gemini} 次, groq ${s.calls.openai} 次`);
}
// hang 的情境要特別看延遲:應該約 = 首字逾時(1.5s),而不是整體逾時
await fake.mode({ gemini: 'ok' });
await waitBreakerClosed();
await fake.mode({ gemini: 'hang' });
u = await newUser();
r = await send(u.token, u.conv, '你好');
check('Gemini 卡住時,延遲 ≈ 單次首字逾時(1.5s)而不是整體 25s', r.ms < 4000 && !!done(r.events), `${Math.round(r.ms)}ms`);

async function waitBreakerClosed() {
  // 等斷路器冷卻 + 用一次正常請求讓它探測成功而關閉
  for (let i = 0; i < 20; i++) {
    const st = await chatStats();
    if (st.llm[0].state === 'closed') return;
    await sleep(700);
    const uu = await newUser();
    await send(uu.token, uu.conv, 'ping');
  }
}

// ---------------------------------------------------------------- 5. 斷路器
console.log('\n— 5. 斷路器:連續失敗後直接跳過壞掉的供應商');
await fake.mode({ gemini: 'ok' });
await waitBreakerClosed();
await fake.reset();
await fake.mode({ gemini: '503' });
u = await newUser();
for (let i = 0; i < 3; i++) await send(u.token, u.conv, `試 ${i}`);
let stats = await chatStats();
check('連續 3 次失敗後 Gemini 斷路器開路', stats.llm[0].state === 'open', stats.llm[0].state);
s = await fake.state();
const before = s.calls.gemini;
const t1 = await send(u.token, u.conv, '開路期間');
s = await fake.state();
check('開路期間不再打 Gemini(直接用 Groq)', s.calls.gemini === before && !!done(t1.events), `gemini 次數 ${before} → ${s.calls.gemini}`);
check('開路期間回覆很快(沒有再等首字逾時)', t1.ms < 1000, `${Math.round(t1.ms)}ms`);
const mt = await metrics();
check('指標記錄了換手與斷路器', metricVal(mt, 'chat_llm_failovers_total', { from: 'gemini', to: 'groq' }) >= 3 && metricVal(mt, 'chat_llm_breaker_open', { provider: 'gemini' }) === 1);
console.log('   等冷卻 (6s) 後 Gemini 恢復,探測成功應關閉斷路器…');
await fake.mode({ gemini: 'ok' });
await sleep(6500);
const probe = await send(u.token, u.conv, '恢復探測');
stats = await chatStats();
check('冷卻後放入探測請求,成功 → 斷路器關閉、回到 Gemini', stats.llm[0].state === 'closed' && !!done(probe.events), stats.llm[0].state);

// ---------------------------------------------------------------- 6. 全部壞掉
console.log('\n— 6. 兩個供應商都壞掉 → 回應「目前有問題」,不扣點');
await waitBreakerClosed();
await fake.reset();
await fake.mode({ gemini: '503', openai: '503' });
u = await newUser();
const failCmid = crypto.randomUUID();
r = await send(u.token, u.conv, '你好', failCmid);
const e = error(r.events);
check('收到 error 事件 LLM_UNAVAILABLE', e?.code === 'LLM_UNAVAILABLE', e?.code);
check('訊息是「目前系統有問題」', /目前系統有問題/.test(e?.message ?? ''), e?.message);
check('標示可重試', e?.retryable === true);
await sleep(400);
b = await balance(u.token);
check('不扣點、預扣已歸還', b.balance === 200 && b.held === 0, JSON.stringify(b));
const hist = (await j('GET', `/conversations/${u.conv}/messages`, u.token)).json.items;
const failedMsg = hist.find((m: any) => m.role === 'assistant' && m.seq === e?.state?.seq) ?? hist[hist.length - 1];
const failedAiId: string = e?.state?.id; // 第一次失敗時 error 事件裡的 AI 訊息 id —— 重試必須沿用它
check('歷史裡該則標為 failed(code=LLM_UNAVAILABLE),可由客戶端重試', failedMsg.status === 'failed' && failedMsg.error_code === 'LLM_UNAVAILABLE', `${failedMsg.status}/${failedMsg.error_code}`);
// 斷路器全開時要快速失敗(下面這 3 則會在「你好」之後送出,所以「你好」那則之後就不再是最新的了)
await send(u.token, u.conv, '再試 1');
await send(u.token, u.conv, '再試 2');
const fastFail = await send(u.token, u.conv, '再試 3');
check('兩家斷路器都開路時快速失敗,不再等逾時', error(fastFail.events)?.code === 'LLM_UNAVAILABLE' && fastFail.ms < 800, `${Math.round(fastFail.ms)}ms`);

// 恢復後:舊的失敗訊息(後面已經有更新的訊息)不能重試 —— 這是後端刻意的保護,避免在對話中間插入亂序的回覆
await fake.mode({ gemini: 'ok', openai: 'ok' });
await sleep(6500);
const stale = await send(u.token, u.conv, '你好', failCmid);
check('已不是最新的失敗訊息不能重試 → 409 RETRY_NOT_LATEST(刻意的保護)', stale.status === 409 && stale.err?.error?.code === 'RETRY_NOT_LATEST', `HTTP ${stale.status} ${stale.err?.error?.code ?? ''}`);

// 失敗後「立刻」重試(中間沒有新訊息):用同一個 client_msg_id,沿用同一則 AI 訊息
await fake.mode({ gemini: '503', openai: '503' });
const u2 = await newUser();
const cmid2 = crypto.randomUUID();
const first = await send(u2.token, u2.conv, '重試用', cmid2);
const firstAi = error(first.events)?.state?.id;
check('(準備)兩家都壞時這則失敗', error(first.events)?.code === 'LLM_UNAVAILABLE' && !!firstAi);
await fake.mode({ gemini: 'ok', openai: 'ok' });
await sleep(6500); // 等斷路器冷卻
const retry = await send(u2.token, u2.conv, '重試用', cmid2);
check('服務恢復後用同一個 client_msg_id 重試成功,沿用同一則 AI 訊息', !!done(retry.events) && done(retry.events).message.id === firstAi, `失敗時=${String(firstAi).slice(0, 8)} 重試後=${String(done(retry.events)?.message?.id).slice(0, 8)}`);
b = await balance(u2.token);
check('重試成功只扣一次點(失敗那次沒扣)', b.balance === 200 - u2.price && b.held === 0, JSON.stringify(b));

// ---------------------------------------------------------------- 7. 邊界:中途失敗 / 內容被擋
console.log('\n— 7. 不該換手的情境');
await waitBreakerClosed();
await fake.reset();
await fake.mode({ gemini: 'midstream_fail' });
u = await newUser();
r = await send(u.token, u.conv, '你好');
s = await fake.state();
const me = error(r.events);
check('已送出部分文字後才失敗 → 回報錯誤,不偷偷換 Groq', !!me && s.calls.openai === 0, `gemini 次數 ${s.calls.gemini}, groq 次數 ${s.calls.openai}`);
check('錯誤中保留已產生的部分文字,且不扣點', (me?.state?.content ?? '').length > 0 && (await balance(u.token)).balance === 200, `部分文字:「${me?.state?.content}」`);

await waitBreakerClosed();
await fake.reset();
await fake.mode({ gemini: 'hang_after_first' });
u = await newUser();
r = await send(u.token, u.conv, '你好');
check('送出第一段後卡住 → 以停滯逾時(1.5s)判定失敗,不會卡到整體 120s', !!error(r.events) && r.ms < 5000, `${Math.round(r.ms)}ms`);

await waitBreakerClosed();
await fake.reset();
await fake.mode({ gemini: 'blocked' });
u = await newUser();
const failuresBefore = (await chatStats()).llm[0].consecutiveFailures; // 前一個情境可能留下殘餘的失敗計數,所以比較「前後是否不變」
r = await send(u.token, u.conv, '你好');
s = await fake.state();
check('內容被安全機制擋下 → LLM_BLOCKED,不換供應商去繞過', error(r.events)?.code === 'LLM_BLOCKED' && s.calls.openai === 0, `${error(r.events)?.code}, groq 次數 ${s.calls.openai}`);
await sleep(500); // 預扣的歸還是非同步的
b = await balance(u.token);
check('被擋的回覆不扣點(預扣已歸還),且不計入斷路器', b.balance === 200 && b.held === 0 && (await chatStats()).llm[0].consecutiveFailures === failuresBefore, `${JSON.stringify(b)}, 斷路器連續失敗 ${failuresBefore} → ${(await chatStats()).llm[0].consecutiveFailures}`);

// ---------------------------------------------------------------- 8. 用量記錄
console.log('\n— 8. 成本可視化:實際用量與供應商被記錄');
await fake.reset();
await waitBreakerClosed();
u = await newUser();
const before2 = metricVal(await metrics(), 'chat_llm_tokens_total', { provider: 'gemini', kind: 'input' });
r = await send(u.token, u.conv, '記錄用量');
const mid = done(r.events).message.id;
const pg = await (await fetch(`${CHAT}/internal/message/${mid}`, { headers: { 'x-internal-token': INTERNAL } })).json() as any;
check('Prometheus 的 token 計數增加(輸入 +120)', metricVal(await metrics(), 'chat_llm_tokens_total', { provider: 'gemini', kind: 'input' }) - before2 === 120);
check('訊息記錄了供應商與模型', pg.provider === 'gemini' && pg.model === 'gemini-2.5-flash-lite', `${pg.provider}/${pg.model}`);
check('訊息記錄了輸入/輸出 token', pg.input_tokens === 120 && pg.output_tokens > 0, `in=${pg.input_tokens} out=${pg.output_tokens}`);

await fake.reset();
console.log(`\n結果:${pass} 通過,${fail} 失敗\n`);
process.exit(fail ? 1 : 0);
