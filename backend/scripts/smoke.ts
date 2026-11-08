// 端到端冒煙測試:打 gateway(對外 API)驗證核心行為。
// 用法:docker compose --profile tools run --rm tools bun scripts/smoke.ts
export {}; // 讓此檔成為獨立的 module,避免與其他腳本的頂層宣告衝突
const BASE = process.argv[2] ?? process.env.GATEWAY_URL ?? 'http://localhost:8080';
const INTERNAL = process.env.INTERNAL_TOKEN ?? 'dev-internal-token-change-me';
const BILLING = process.env.BILLING_URL ?? 'http://localhost:3004';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
}

interface Resp {
  status: number;
  json: any;
}
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Resp> {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    await res.body?.cancel();
    return { status: res.status, json: { sse: true } };
  }
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

interface SseEvent {
  event: string;
  data: any;
  id?: string;
}
/** 讀完整個 SSE 串流,回傳所有事件;onEvent 可在中途介入(例如模擬斷線)。 */
async function sse(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  onEvent?: (e: SseEvent, abort: () => void) => void,
): Promise<{ status: number; events: SseEvent[]; json?: any }> {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: ac.signal,
  });
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    return { status: res.status, events: [], json: await res.json().catch(() => null) };
  }
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: SseEvent = { event: 'message', data: null };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data = JSON.parse(line.slice(5).trim());
          else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
        }
        if (block.startsWith(':')) continue;
        events.push(ev);
        onEvent?.(ev, () => ac.abort());
      }
    }
  } catch {
    /* abort */
  }
  return { status: res.status, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomUUID();
const text = (events: SseEvent[]) => events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');

async function main(): Promise<void> {
  const name = `smoke_${Date.now().toString(36)}`;
  console.log(`\n=== Chat APP 冒煙測試 → ${BASE}  (使用者 ${name}) ===\n`);

  // ---------------------------------------------------------------- 認證 / 單一裝置
  console.log('— 認證與單一裝置');
  const reg = await api('POST', '/auth/register', {
    body: { username: name, password: 'secret123', device_id: 'dev-A', device_name: 'MacBook' },
  });
  check('註冊成功並直接登入', reg.status === 201 && !!reg.json.token);
  const tokenA = reg.json.token as string;
  check('未帶 token 存取被拒', (await api('GET', '/characters')).status === 401);
  check('裝置 A 可以使用', (await api('GET', '/characters', { token: tokenA })).status === 200);

  // 裝置 A 先開著事件通道,等 B 登入後應立刻收到 session_replaced
  let kicked: any = null;
  const evRes = await fetch(`${BASE}/v1/events`, { headers: { authorization: `Bearer ${tokenA}` } });
  const evReader = evRes.body!.getReader();
  const evDone = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await evReader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: session_replaced')) {
        kicked = true;
        return;
      }
    }
  })();

  const loginB = await api('POST', '/auth/login', {
    body: { username: name, password: 'secret123', device_id: 'dev-B', device_name: 'iPad' },
  });
  const tokenB = loginB.json.token as string;
  check('裝置 B 登入成功,並回報取代了 MacBook', loginB.status === 200 && loginB.json.replaced_device === 'MacBook');
  await Promise.race([evDone, sleep(1500)]);
  check('裝置 A 的事件通道即時收到 session_replaced', kicked === true);
  const oldTry = await api('GET', '/characters', { token: tokenA });
  check('裝置 A 的舊 token 立刻失效', oldTry.status === 401 && oldTry.json.error.code === 'SESSION_REPLACED', oldTry.json?.error?.code);
  check('裝置 B 可以使用', (await api('GET', '/characters', { token: tokenB })).status === 200);
  check('錯誤密碼被拒', (await api('POST', '/auth/login', { body: { username: name, password: 'nope', device_id: 'x', device_name: 'x' } })).status === 401);
  const token = tokenB;

  // ---------------------------------------------------------------- 角色 / 對話
  console.log('\n— 角色與對話');
  const chars = await api('GET', '/characters', { token });
  const xi = chars.json.items.find((c: any) => c.slug === 'xi');
  check('角色列表 4 位,且不外洩 persona', chars.json.items.length >= 4 && !('persona' in xi));
  const conv = await api('POST', '/conversations', { token, body: { character_id: xi.id } });
  check('建立對話(含開場白)', conv.status === 201 && conv.json.latest_seq === 1);
  const conv2 = await api('POST', '/conversations', { token, body: { character_id: xi.id } });
  check('同一角色重複建立回傳同一個對話', conv2.status === 200 && conv2.json.id === conv.json.id);
  const cid = conv.json.id as string;

  // ---------------------------------------------------------------- 聊天串流 + 點數
  console.log('\n— 串流聊天與點數');
  const bal0 = (await api('GET', '/points/balance', { token })).json;
  check('註冊贈點 200', bal0.balance === 200 && bal0.available === 200);

  const m1 = uid();
  const t0 = performance.now();
  let firstDeltaMs = 0;
  const r1 = await sse('POST', `/conversations/${cid}/messages`, token, { content: '你好', client_msg_id: m1 }, (e) => {
    if (e.event === 'delta' && !firstDeltaMs) firstDeltaMs = performance.now() - t0;
  });
  const done1 = r1.events.find((e) => e.event === 'done');
  check('收到 user_message / assistant_start / delta... / done', r1.events[0]?.event === 'user_message' && r1.events[1]?.event === 'assistant_start' && !!done1);
  check('回覆是逐步串流的(多個 delta)', r1.events.filter((e) => e.event === 'delta').length > 5, `${r1.events.filter((e) => e.event === 'delta').length} 個 delta,首字 ${Math.round(firstDeltaMs)}ms`);
  check('串流拼起來 = done 的完整內容', text(r1.events) === done1?.data.message.content, text(r1.events).slice(0, 30));
  check('done 帶回扣點後餘額 198', done1?.data.balance === 198, String(done1?.data.balance));

  // 冪等:同一個 client_msg_id 重送,不會重複扣點、不會多一則訊息
  const r1b = await sse('POST', `/conversations/${cid}/messages`, token, { content: '你好', client_msg_id: m1 });
  const done1b = r1b.events.find((e) => e.event === 'done');
  check('相同 client_msg_id 重送 → 回放同一則回覆', done1b?.data.message.id === done1?.data.message.id);
  const bal1 = (await api('GET', '/points/balance', { token })).json;
  check('冪等重送沒有重複扣點', bal1.balance === 198, String(bal1.balance));

  // 歷史
  const h1 = await api('GET', `/conversations/${cid}/messages`, { token });
  check('歷史依序:開場白、使用者、AI', h1.json.items.map((m: any) => m.role).join() === 'assistant,user,assistant' && h1.json.items.map((m: any) => m.seq).join() === '1,2,3');

  // ---------------------------------------------------------------- 失敗 → 釋放點數 → 重試
  console.log('\n— 失敗時不扣點、可重試');
  const mFail = uid();
  const rf = await sse('POST', `/conversations/${cid}/messages`, token, { content: '測試錯誤 [[fail]]', client_msg_id: mFail });
  const errEv = rf.events.find((e) => e.event === 'error');
  check('模型中途出錯 → 收到 error 事件(可重試)', !!errEv && errEv.data.retryable === true, errEv?.data?.code);
  await sleep(300);
  const balF = (await api('GET', '/points/balance', { token })).json;
  check('失敗的回覆沒有扣點、預扣已歸還', balF.balance === 198 && balF.held === 0, JSON.stringify(balF));
  const rr = await sse('POST', `/conversations/${cid}/messages`, token, { content: '測試錯誤 [[fail]]', client_msg_id: mFail });
  check('用同一個 client_msg_id 重試 → 沿用同一則 AI 訊息(這次 mock 仍會失敗,但走的是重試路徑)', rr.events.some((e) => e.event === 'error' && e.data.state.id === errEv!.data.state.id));
  const hF = await api('GET', `/conversations/${cid}/messages`, { token });
  check('重試沒有在歷史留下殘骸(只多 2 則:使用者 + 失敗的 AI)', hF.json.items.length === 5, `共 ${hF.json.items.length} 則`);

  // ---------------------------------------------------------------- 斷線續傳
  console.log('\n— 斷線續傳(生成與連線脫鉤)');
  const mSlow = uid();
  let assistantId = '';
  let got = 0;
  await sse('POST', `/conversations/${cid}/messages`, token, { content: '請慢慢回答 [[slow]]', client_msg_id: mSlow }, (e, abort) => {
    if (e.event === 'assistant_start') assistantId = e.data.id;
    if (e.event === 'delta' && ++got >= 3) abort(); // 收到 3 個片段就「斷網」
  });
  check('模擬斷線:只收到前幾個片段', got >= 3 && !!assistantId, `收到 ${got} 個`);
  const resumed = await sse('GET', `/conversations/${cid}/messages/${assistantId}/stream`, token);
  const snap = resumed.events.find((e) => e.event === 'snapshot');
  const doneR = resumed.events.find((e) => e.event === 'done');
  check('重新連線後收到 snapshot(斷線期間產生的內容)並接續到完成', !!snap && !!doneR, `snapshot ${snap?.data.content.length ?? 0} 字`);
  const finalText = (snap?.data.content ?? '') + text(resumed.events);
  check('snapshot + 後續 delta = 完整內容', finalText === doneR?.data.message.content);
  const balS = (await api('GET', '/points/balance', { token })).json;
  check('斷線的那則回覆仍然完成並扣點(198 → 196)', balS.balance === 196, String(balS.balance));

  // ---------------------------------------------------------------- 同對話並發
  console.log('\n— 併發保護');
  const slowSend = sse('POST', `/conversations/${cid}/messages`, token, { content: '第一則 [[slow]]', client_msg_id: uid() });
  await sleep(200);
  const second = await api('POST', `/conversations/${cid}/messages`, { token, body: { content: '第二則', client_msg_id: uid() } });
  check('同一對話已有回覆進行中 → 409', second.status === 409 && second.json.error.code === 'GENERATION_IN_PROGRESS', second.json?.error?.code);
  await slowSend;

  // ---------------------------------------------------------------- 點數明細
  console.log('\n— 點數明細');
  const led = await api('GET', '/points/ledger', { token });
  const kinds = led.json.items.map((i: any) => `${i.type}:${i.amount}`);
  check('明細:註冊贈點 +200,每則成功回覆 -2(共 3 則成功,失敗的不在明細)', kinds.includes('grant:200') && kinds.filter((k: string) => k === 'charge:-2').length === 3, kinds.join(' '));
  check('明細帶有可追溯資訊(哪個角色、哪則訊息)', led.json.items.find((i: any) => i.type === 'charge')?.note === '與小曦的對話');

  // ---------------------------------------------------------------- 點數不足 / 不超扣(直接打 billing 內部 API 搶最後的點數)
  console.log('\n— 點數不足與不超扣');
  const meId = (await api('GET', '/me', { token })).json.id as string;
  const before = (await api('GET', '/points/balance', { token })).json;
  const burnAmount = before.available - 1; // 只留 1 點可用(一則回覆要 2 點)
  const burnRef = `burn-${uid()}`;
  const burn = await fetch(`${BILLING}/internal/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL },
    body: JSON.stringify({ ref: burnRef, user_id: meId, amount: burnAmount }),
  });
  check(`預扣 ${burnAmount} 點(剩 1 點可用)`, burn.status === 200);
  const poor = await api('POST', `/conversations/${cid}/messages`, { token, body: { content: '還有點數嗎', client_msg_id: uid() } });
  check('可用點數不足 → 402 INSUFFICIENT_POINTS', poor.status === 402 && poor.json.error.code === 'INSUFFICIENT_POINTS', poor.json?.error?.code);
  const hP = await api('GET', `/conversations/${cid}/messages`, { token });
  check('點數不足時沒有留下任何訊息', !hP.json.items.some((m: any) => m.content === '還有點數嗎'));

  // 歸還預扣後,又可以聊天了
  await fetch(`${BILLING}/internal/holds/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL },
    body: JSON.stringify({ ref: burnRef }),
  });
  const again = await sse('POST', `/conversations/${cid}/messages`, token, { content: '點數回來了', client_msg_id: uid() });
  check('預扣歸還後又可以聊天', again.events.some((e) => e.event === 'done'));

  // ---------------------------------------------------------------- 登出
  console.log('\n— 登出');
  check('登出成功', (await api('POST', '/auth/logout', { token })).status === 200);
  const after = await api('GET', '/characters', { token });
  check('登出後 token 失效', after.status === 401 && after.json.error.code === 'SESSION_EXPIRED', after.json?.error?.code);
  // 回歸:登出後「立刻」重新登入,新 token 必須馬上可用(不能被 gateway 的負向快取擋住)
  const relog = await api('POST', '/auth/login', { body: { username: name, password: 'secret123', device_id: 'dev-B', device_name: 'iPad' } });
  const relogUse = await api('GET', '/me', { token: relog.json.token });
  check('登出後立刻重新登入,新 token 馬上可用', relog.status === 200 && relogUse.status === 200, `重新登入 ${relog.status},使用 ${relogUse.status} ${relogUse.json?.error?.code ?? ''}`);

  console.log(`\n結果:${passed} 通過,${failed} 失敗\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
