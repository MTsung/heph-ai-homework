// 訂位(AI 代辦)端到端驗證:從 gateway 的對外 API 走完整流程,並用模擬器的 /__debug 確認「對方實際收到什麼」。
//
//   docker compose --profile tools run --rm tools bun booking/scripts/booking-smoke.ts     (在 compose 網路內)
//   bun booking/scripts/booking-smoke.ts                                                 (在主機;模擬器對外埠 9190)
//
// 需要:docker compose up 已啟動。會呼叫 booking 的資料庫(模擬方案過期)與 billing 的內部 API(模擬點數不足)。
// 預設的需求理解是規則解析或你設定的 LLM;若用 LLM,語句的解析結果可能略有不同 —— 這支腳本只依賴結構化輸入以外的「找店條件」。
import { Pool } from 'pg';
export {};

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const SIM = process.env.SIM_URL ?? 'http://localhost:9190';
const BILLING = process.env.BILLING_URL ?? 'http://localhost:3004';
const INTERNAL = process.env.INTERNAL_TOKEN ?? 'dev-internal-token-change-me';
const DB = process.env.BOOKING_DATABASE_URL ?? 'postgres://chatapp:chatapp@localhost:5432/booking';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
}
const section = (s: string) => console.log(`\n— ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Resp {
  status: number;
  json: any;
  headers: Headers;
}
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Resp> {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function until<T>(fn: () => Promise<T | false>, timeoutMs: number, everyMs = 400): Promise<T | false> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- 工具
interface User {
  token: string;
  id: string;
  name: string;
}
async function newUser(): Promise<User> {
  const name = `bk${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const r = await api('POST', '/auth/register', { body: { username: name, password: 'secret123', device_id: 'smoke', device_name: 'smoke' } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`註冊失敗 ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.token, id: r.json.user.id, name };
}
const balance = async (u: User): Promise<number> => (await api('GET', '/points/balance', { token: u.token })).json.available;
const getB = async (u: User, id: string) => (await api('GET', `/bookings/${id}`, { token: u.token })).json;
const simReservations = async (): Promise<any[]> => ((await (await fetch(`${SIM}/__debug/reservations`)).json()) as any).items;

/** 未來第一個符合條件的星期幾(台北時間),避開公休日 */
function nextDate(dow: number, minDaysAhead = 3): string {
  const t = new Date(Date.now() + 8 * 3600_000);
  for (let i = minDaysAhead; i < minDaysAhead + 14; i++) {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + i));
    if (d.getUTCDay() === dow) return d.toISOString().slice(0, 10);
  }
  throw new Error('no date');
}
const FRIDAY = nextDate(5);
const MONDAY = nextDate(1); // 檜木割烹公休

interface PlanOpts {
  text: string;
  pick: string;
  date?: string;
  time?: string;
  party?: number;
  contact?: { name: string; phone?: string; email?: string };
  extra?: Record<string, string>;
}
/** 建立需求 → 選店 → 補齊資料,直到出現方案。全程用結構化輸入,結果可預期 */
async function toPlan(u: User, o: PlanOpts): Promise<{ id: string; hash: string; booking: any }> {
  const c = await api('POST', '/bookings', { token: u.token, body: { text: o.text } });
  if (c.status !== 201) throw new Error(`建立失敗 ${c.status} ${JSON.stringify(c.json)}`);
  const id = c.json.id;
  let r = await api('PATCH', `/bookings/${id}/slots`, {
    token: u.token,
    body: { restaurant_id: o.pick, date: o.date ?? FRIDAY, time: o.time ?? '19:00', party_size: o.party ?? 4 },
  });
  if (r.status !== 200) throw new Error(`選店失敗 ${r.status} ${JSON.stringify(r.json)}`);
  if (r.json.status !== 'awaiting_confirmation') {
    r = await api('PATCH', `/bookings/${id}/slots`, {
      token: u.token,
      body: { contact: o.contact ?? { name: '王小明', phone: '0912345678', email: 'ming@example.com' }, ...(o.extra ? { extra: o.extra } : {}) },
    });
    if (r.status !== 200) throw new Error(`補資料失敗 ${r.status} ${JSON.stringify(r.json)}`);
  }
  if (r.json.status !== 'awaiting_confirmation') throw new Error(`沒有產生方案:${JSON.stringify(r.json.pending)}`);
  return { id, hash: r.json.plan.hash, booking: r.json };
}

const confirm = (u: User, id: string, hash: string) => api('POST', `/bookings/${id}/confirm`, { token: u.token, body: { plan_hash: hash } });
const finalStatuses = ['succeeded', 'failed', 'unknown'];
const waitDone = (u: User, id: string, ms = 25_000) => until(async () => {
  const b = await getB(u, id);
  return finalStatuses.includes(b.status) ? b : false;
}, ms);
/** 一筆訂位可能有多次確認嘗試(例如點數不足被拒後再確認),以最後一次為準 */
const execCharge = (b: any) => [...(b.charges ?? [])].reverse().find((c: any) => c.kind === 'exec');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DB, max: 2 });
  await fetch(`${SIM}/__debug/reset`, { method: 'POST' });

  // ================================================================== 1. 判斷是不是訂位需求
  section('1. 判斷是不是訂位需求');
  const u1 = await newUser();
  check('一般聊天不是訂位需求', (await api('POST', '/bookings/detect', { token: u1.token, body: { text: '今天好累,想聊聊' } })).json.is_booking === false);
  check('「幫我訂…」是訂位需求', (await api('POST', '/bookings/detect', { token: u1.token, body: { text: '幫我訂週五晚上的餐廳' } })).json.is_booking === true);
  const before = await balance(u1);
  const notBooking = await api('POST', '/bookings', { token: u1.token, body: { text: '今天天氣真好' } });
  check('非訂位需求被拒絕(422),不建立、不扣點', notBooking.status === 422 && notBooking.json.error.code === 'NOT_BOOKING_INTENT' && (await balance(u1)) === before);
  check('需要登入', (await api('GET', '/bookings')).status === 401);

  // ================================================================== 2. 找店:PDF 的範例句
  section('2. 一句話提出需求 → 找店給使用者選擇');
  const c1 = await api('POST', '/bookings', { token: u1.token, body: { text: '幫我訂這週五晚上 7 點，4 個人，信義區的日式料理', client_request_id: 'req-1' } });
  check('建立成功(201)', c1.status === 201, `${c1.status} ${JSON.stringify(c1.json?.error ?? '')}`);
  const b1 = c1.json;
  check('進入選店階段,有候選店家', b1.status === 'collecting' && b1.pending?.kind === 'choose_restaurant' && b1.pending.options.length >= 3, b1.pending?.kind);
  check('候選店家都在信義區、是日式、可線上訂位', b1.pending.options.every((o: any) => o.district === '信義區' && o.cuisine === '日式' && ['web_form', 'platform_api'].includes(o.booking)));
  check('只列出有訂位連結的店(沒有線上訂位的不會出現)', !b1.pending.options.some((o: any) => o.id === 'r_noodle'));
  check('解析出時間 / 人數 / 日期', b1.slots.time === '19:00' && b1.slots.party_size === 4 && /^\d{4}-\d{2}-\d{2}$/.test(b1.slots.date), JSON.stringify(b1.slots));
  check('這一輪扣 1 點', (await balance(u1)) === before - 1);
  const c1b = await api('POST', '/bookings', { token: u1.token, body: { text: '幫我訂這週五晚上 7 點，4 個人，信義區的日式料理', client_request_id: 'req-1' } });
  check('同一個 client_request_id 重送:回傳同一筆、不重複扣點', c1b.status === 200 && c1b.json.id === b1.id && (await balance(u1)) === before - 1);

  // ================================================================== 3. 補資料:每家店要的不一樣
  section('3. 缺資料時詢問(各家店必填欄位不同)');
  const pick = async (u: User, id: string, rid: string) =>
    (await api('PATCH', `/bookings/${id}/slots`, { token: u.token, body: { restaurant_id: rid, date: FRIDAY, time: '19:00', party_size: 4 } })).json;
  const askKeys = (b: any) => (b.pending?.kind === 'provide_info' ? b.pending.fields.map((f: any) => f.key).sort() : []);
  const sakura = await pick(u1, b1.id, 'r_sakura');
  check('櫻花亭:要姓名 + 電話(不用 email)', JSON.stringify(askKeys(sakura)) === JSON.stringify(['contact.name', 'contact.phone']), askKeys(sakura).join(','));
  const u2 = await newUser();
  const b2 = (await api('POST', '/bookings', { token: u2.token, body: { text: '幫我訂信義區的日式料理' } })).json;
  const hinoki = await pick(u2, b2.id, 'r_hinoki');
  check('檜木割烹:姓名 + 電話 + email', JSON.stringify(askKeys(hinoki)) === JSON.stringify(['contact.email', 'contact.name', 'contact.phone']), askKeys(hinoki).join(','));
  const u3 = await newUser();
  const b3 = (await api('POST', '/bookings', { token: u3.token, body: { text: '幫我訂信義區的日式料理' } })).json;
  const izakaya = await pick(u3, b3.id, 'r_izakaya');
  const seatField = izakaya.pending?.fields?.find((f: any) => f.key === 'extra.seating');
  check('夜行居酒屋:多一個必填的「座位偏好」下拉選單', seatField?.type === 'select' && seatField.options.includes('包廂'), JSON.stringify(seatField));
  const badPhone = await api('PATCH', `/bookings/${b2.id}/slots`, { token: u2.token, body: { contact: { name: 'A', phone: 'abc' } } });
  check('電話格式錯誤 → 400', badPhone.status === 400);
  const wrongPick = await api('PATCH', `/bookings/${b3.id}/slots`, { token: u3.token, body: { restaurant_id: 'r_noodle' } });
  check('只能選候選清單裡的店,不能指定任意店 → 400', wrongPick.status === 400 && wrongPick.json.error.code === 'INVALID_CHOICE');
  const free = await api('POST', `/bookings/${b2.id}/messages`, { token: u2.token, body: { text: '我叫陳小華 電話 0922-333-444 信箱 hua@example.com' } });
  check('用一句話補資料(自然語言)→ 出方案', free.json.status === 'awaiting_confirmation' && free.json.plan.contact.phone === '0922333444', JSON.stringify(free.json.plan?.contact ?? free.json.pending));

  // ================================================================== 4. 方案、確認、只送出確認的內容
  section('4. 方案確認:確認了什麼就只送出什麼');
  const sakuraDone = await api('PATCH', `/bookings/${b1.id}/slots`, { token: u1.token, body: { contact: { name: '林大明', phone: '0988-111-222' } } });
  check('資料齊全 → 產生方案,等待確認', sakuraDone.json.status === 'awaiting_confirmation' && sakuraDone.json.plan.can_confirm === true && !!sakuraDone.json.plan.expires_at);
  const v1 = sakuraDone.json.plan;
  const changed = await api('POST', `/bookings/${b1.id}/messages`, { token: u1.token, body: { text: '改成 8 點' } });
  check('使用者改條件 → 新方案(版本 +1、雜湊不同)', changed.json.plan?.version === v1.version + 1 && changed.json.plan.hash !== v1.hash && changed.json.plan.time === '20:00', `${changed.json.plan?.time} v${changed.json.plan?.version}`);
  const stale = await confirm(u1, b1.id, v1.hash);
  check('用舊方案的雜湊確認 → 409 PLAN_CHANGED,並附上最新方案', stale.status === 409 && stale.json.error.code === 'PLAN_CHANGED' && stale.json.error.current?.time === '20:00');
  check('舊方案被拒絕後,沒有任何東西送出', (await simReservations()).length === 0);
  const noChange = await api('POST', `/bookings/${b1.id}/messages`, { token: u1.token, body: { text: '好,確認' } });
  check('在對話裡打「確認」不會送出(必須明確呼叫確認並帶方案雜湊)', noChange.json.status === 'awaiting_confirmation' && (await simReservations()).length === 0);

  const beforeConfirm = await balance(u1);
  const hash2 = changed.json.plan.hash;
  const conf = await confirm(u1, b1.id, hash2);
  check('確認 → 202,進入執行', conf.status === 202 && ['confirmed', 'executing', 'succeeded'].includes(conf.json.status), conf.json?.status ?? conf.json?.error?.code);
  const conf2 = await confirm(u1, b1.id, hash2);
  check('重送同一份確認:冪等,不會重複執行', conf2.status === 202 && conf2.json.id === b1.id);
  const done1 = await waitDone(u1, b1.id);
  check('最終成功,並拿到訂位代號', !!done1 && done1.status === 'succeeded' && /^WF-/.test(done1.result?.confirmation_no ?? ''), done1 ? done1.status : 'timeout');
  const rs = (await simReservations()).filter((r) => r.restaurant_id === 'r_sakura');
  check('對方只收到 1 筆,內容就是使用者確認的方案', rs.length === 1 && rs[0].time === '20:00' && rs[0].date === FRIDAY && rs[0].party_size === 4 && rs[0].name === '林大明' && rs[0].phone === '0988111222', JSON.stringify(rs[0] ?? null));
  check('確認的方案已凍結並記錄', done1.confirmed_plan?.hash === hash2 && done1.confirmed_plan.time === '20:00');
  await sleep(500);
  check('成功才扣訂位費(3 點)', (await balance(u1)) === beforeConfirm - 3 && execCharge(await getB(u1, b1.id))?.state === 'settled');
  const ledger = (await api('GET', '/points/ledger', { token: u1.token })).json.items;
  check('點數明細有:訂位費(booking)與 AI 理解(booking_turn),註明用途', ledger.some((l: any) => l.ref_type === 'booking' && l.amount === -3 && /櫻花亭/.test(l.note)) && ledger.filter((l: any) => l.ref_type === 'booking_turn').length >= 3);
  const afterDone = await api('POST', `/bookings/${b1.id}/messages`, { token: u1.token, body: { text: '改成 9 點' } });
  check('完成後不能再改 → 409', afterDone.status === 409);
  const cancelDone = await api('POST', `/bookings/${b1.id}/cancel`, { token: u1.token });
  check('已送出的訂位不能取消 → 409', cancelDone.status === 409 && cancelDone.json.error.code === 'CANNOT_CANCEL');

  // ================================================================== 5. 可以隨時離開再回來
  section('5. 隨時離開再回來');
  const u4 = await newUser();
  const p4 = await toPlan(u4, { text: '幫我訂信義區的日式料理', pick: 'r_hinoki', date: nextDate(3), time: '18:30' });
  // 「重新開 App」:沒有任何本機狀態,只靠 token 查詢
  const list = await api('GET', '/bookings?status=active', { token: u4.token });
  check('回來後從列表找到進行中的需求,帶有期限', list.json.items.length === 1 && list.json.items[0].id === p4.id && list.json.items[0].status === 'awaiting_confirmation' && !!list.json.items[0].expires_at);
  const back = await getB(u4, p4.id);
  check('完整的對話紀錄與待確認的方案都還在', back.plan.hash === p4.hash && back.events.filter((e: any) => e.type === 'user').length >= 2 && back.pending.kind === 'confirm_plan');
  const other = await newUser();
  check('別人看不到這筆需求(404)', (await api('GET', `/bookings/${p4.id}`, { token: other.token })).status === 404);
  const cancelled = await api('POST', `/bookings/${p4.id}/cancel`, { token: u4.token });
  check('可以取消', cancelled.json.status === 'cancelled' && (await api('GET', '/bookings?status=active', { token: u4.token })).json.items.length === 0);

  // ================================================================== 6. 方案期限
  section('6. 方案有確認期限');
  const u5 = await newUser();
  const p5 = await toPlan(u5, { text: '幫我訂信義區的日式料理', pick: 'r_sakura' });
  const bal5 = await balance(u5);
  await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [p5.id]);
  const late = await confirm(u5, p5.id, p5.hash);
  check('過期後確認 → 409 PLAN_EXPIRED', late.status === 409 && late.json.error.code === 'PLAN_EXPIRED');
  const exp = await getB(u5, p5.id);
  check('狀態為 expired,不能再確認,也沒有扣訂位費', exp.status === 'expired' && exp.plan?.can_confirm !== true && (await balance(u5)) === bal5 && !execCharge(exp));
  check('過期後也不能再修改', (await api('POST', `/bookings/${p5.id}/messages`, { token: u5.token, body: { text: '改成 8 點' } })).status === 409);
  // 背景掃描也會把狀態落地(使用者沒有再來查詢的情況)
  const u5b = await newUser();
  const p5b = await toPlan(u5b, { text: '幫我訂信義區的日式料理', pick: 'r_sakura' });
  await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [p5b.id]);
  const swept = await until(async () => (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [p5b.id])).rows[0].status === 'expired', 15_000);
  check('背景任務會把過期的方案標記為 expired', swept !== false);

  // ================================================================== 7. 指定店家 / 搜尋訂位連結
  section('7. 指定店家:搜尋有沒有訂位連結');
  const u6 = await newUser();
  const named = (await api('POST', '/bookings', { token: u6.token, body: { text: `幫我訂鼎泰豐 ${FRIDAY} 晚上7點 2位` } })).json;
  check('店名對應到多家分店 → 請使用者選擇', named.pending?.kind === 'choose_restaurant' && named.pending.options.length === 2 && named.pending.options.every((o: any) => /鼎泰豐/.test(o.name)), JSON.stringify(named.pending?.options?.map((o: any) => o.name) ?? named.pending));
  const viaText = await api('POST', `/bookings/${named.id}/messages`, { token: u6.token, body: { text: '第二家' } });
  check('用文字回答「第二家」就能選店', viaText.json.slots?.restaurant?.id === named.pending.options[1].id, viaText.json.slots?.restaurant?.name);
  const u7 = await newUser();
  const noLink = (await api('POST', '/bookings', { token: u7.token, body: { text: `幫我訂老張牛肉麵 ${FRIDAY} 晚上7點 2位` } })).json;
  const lastMsg = [...noLink.events].reverse().find((e: any) => e.type === 'assistant')?.text ?? '';
  check('找得到店但搜尋不到訂位連結 → 明說無法代訂並附上電話,不會假裝訂得成', noLink.status === 'collecting' && /沒辦法幫你代訂/.test(lastMsg) && /02-2555-0001/.test(lastMsg), lastMsg.slice(0, 80));
  check('同時列出同一區可線上訂位的替代店家', noLink.pending?.kind === 'choose_restaurant' || noLink.pending?.kind === 'provide_request', noLink.pending?.kind);
  const closed = (await api('POST', '/bookings', { token: u7.token, body: { text: '幫我訂信義區的日式料理' } })).json;
  const closedR = await api('PATCH', `/bookings/${closed.id}/slots`, { token: u7.token, body: { restaurant_id: 'r_hinoki', date: MONDAY, time: '19:00', party_size: 2 } });
  check('店家公休 → 請使用者改日期,不出方案', closedR.json.pending?.kind === 'provide_slots' && closedR.json.pending.fields.includes('date') && closedR.json.plan === null, JSON.stringify(closedR.json.pending));
  const lateNight = (await api('POST', '/bookings', { token: u7.token, body: { text: '幫我訂信義區的日式料理' } })).json;
  const noTime = await api('PATCH', `/bookings/${lateNight.id}/slots`, { token: u7.token, body: { restaurant_id: 'r_sakura', date: FRIDAY, time: '23:00', party_size: 2 } });
  check('指定的時段沒有位子 → 列出可選的時段', noTime.json.pending?.kind === 'choose_time' && noTime.json.pending.options.includes('19:00'), JSON.stringify(noTime.json.pending));

  // ================================================================== 8. 失敗與異常
  section('8. 異常情況');
  const u8 = await newUser();
  const full = await toPlan(u8, { text: '幫我訂大安區的台菜', pick: 'r_full' });
  const balFull = await balance(u8);
  await confirm(u8, full.id, full.hash);
  const fullDone = await waitDone(u8, full.id);
  check('店家客滿 → failed,附原因', !!fullDone && fullDone.status === 'failed' && fullDone.result.code === 'FULL', fullDone ? fullDone.result?.code : 'timeout');
  await sleep(500);
  check('失敗不扣點(預扣已歸還)', (await balance(u8)) === balFull && execCharge(await getB(u8, full.id))?.state === 'released');
  check('客滿的店沒有收到訂位', (await simReservations()).filter((r) => r.restaurant_id === 'r_full').length === 0);

  const u9 = await newUser();
  const flaky = await toPlan(u9, { text: '幫我訂大安區的義式料理', pick: 'r_trattoria' });
  await confirm(u9, flaky.id, flaky.hash);
  const flakyDone = await waitDone(u9, flaky.id);
  const fr = (await simReservations()).filter((r) => r.restaurant_id === 'r_trattoria');
  check('平台第一次回 503(其實已收單)→ 用同一個冪等鍵重送 → 成功', !!flakyDone && flakyDone.status === 'succeeded', flakyDone ? flakyDone.status : 'timeout');
  check('平台那邊只有 1 筆訂位(沒有重複)', fr.length === 1 && fr[0].idempotency_key === flaky.id, `${fr.length} 筆`);

  // 結果不明:要等 SUBMIT_TIMEOUT_MS(預設 15 秒)
  const u10 = await newUser();
  const drop = await toPlan(u10, { text: '幫我訂大安區的燒肉', pick: 'r_yakiniku' });
  const balDrop = await balance(u10);
  await confirm(u10, drop.id, drop.hash);
  const midway = await getB(u10, drop.id);
  check('送出後可以隨時查進度(執行中)', ['confirmed', 'executing'].includes(midway.status), midway.status);
  const dropDone = await waitDone(u10, drop.id, 40_000);
  check('送出了但店家沒回應 → unknown(結果不明),不是 failed、也不是 succeeded', !!dropDone && dropDone.status === 'unknown' && dropDone.result.code === 'RESULT_UNKNOWN', dropDone ? dropDone.status : 'timeout');
  await sleep(500);
  check('結果不明不扣點', (await balance(u10)) === balDrop && execCharge(await getB(u10, drop.id))?.state === 'released');
  await sleep(6000);
  check('網頁表單沒有冪等機制 → 絕不自動重送(對方仍然只有 1 筆)', (await simReservations()).filter((r) => r.restaurant_id === 'r_yakiniku').length === 1);

  // ================================================================== 9. 同時最多 3 人,其餘回繁忙
  section('9. 同時處理上限(預設 3):超過回「繁忙」');
  const crowd: Array<{ u: User; id: string; hash: string }> = [];
  for (let i = 0; i < 4; i++) {
    const u = await newUser();
    crowd.push({ u, ...(await toPlan(u, { text: '幫我訂信義區的日式料理', pick: 'r_sakura', contact: { name: `擁擠${i}`, phone: `091200000${i}` } })) });
  }
  const results = await Promise.all(crowd.map((x) => confirm(x.u, x.id, x.hash)));
  const accepted = results.filter((r) => r.status === 202);
  const busy = results.filter((r) => r.status === 503);
  check('同時 4 人確認:3 人受理、1 人回繁忙', accepted.length === 3 && busy.length === 1, `受理 ${accepted.length} / 繁忙 ${busy.length}`);
  const busyIdx = results.findIndex((r) => r.status === 503);
  check('繁忙回應帶 SERVER_BUSY 與 retry_after / Retry-After 標頭', busy[0]?.json.error.code === 'SERVER_BUSY' && busy[0].json.error.retry_after > 0 && !!busy[0].headers.get('retry-after'));
  const busyB = await getB(crowd[busyIdx]!.u, crowd[busyIdx]!.id);
  check('被擋下的那筆沒有任何改變:仍可確認、沒有預扣', busyB.status === 'awaiting_confirmation' && !execCharge(busyB) && (await balance(crowd[busyIdx]!.u)) === 200 - 1);
  const others = await Promise.all(crowd.filter((_, i) => i !== busyIdx).map((x) => waitDone(x.u, x.id)));
  check('另外 3 人都成功', others.every((b) => b && b.status === 'succeeded'));
  const retry = await confirm(crowd[busyIdx]!.u, crowd[busyIdx]!.id, crowd[busyIdx]!.hash);
  check('名額釋放後,被擋下的那位重試就受理', retry.status === 202, String(retry.status));
  check('且最後成功', (await waitDone(crowd[busyIdx]!.u, crowd[busyIdx]!.id))?.status === 'succeeded');

  // ================================================================== 10. 點數
  section('10. 點數不足');
  const u11 = await newUser();
  const poor = await toPlan(u11, { text: '幫我訂信義區的日式料理', pick: 'r_sakura' });
  const avail = await balance(u11);
  const hold = await fetch(`${BILLING}/internal/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL },
    body: JSON.stringify({ ref: `smoke:${poor.id}`, user_id: u11.id, amount: avail - 1, ttl_sec: 60 }),
  });
  check('(準備)預扣掉其餘點數,只剩 1 點可用', hold.status === 200);
  const noMoney = await confirm(u11, poor.id, poor.hash);
  check('點數不足 → 402,方案維持原狀', noMoney.status === 402 && noMoney.json.error.code === 'INSUFFICIENT_POINTS' && (await getB(u11, poor.id)).status === 'awaiting_confirmation');
  const noMoneyMsg = await api('POST', `/bookings/${poor.id}/messages`, { token: u11.token, body: { text: '改成 8 點' } });
  check('1 點還夠 AI 理解一次(扣 1 點),之後再說就不夠了', noMoneyMsg.status === 200 && (await api('POST', `/bookings/${poor.id}/messages`, { token: u11.token, body: { text: '改成 9 點' } })).status === 402);
  await fetch(`${BILLING}/internal/holds/release`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL }, body: JSON.stringify({ ref: `smoke:${poor.id}` }) });
  const poorNow = await getB(u11, poor.id);
  check('補回點數後可以正常確認(同一份方案,不用重做)', (await confirm(u11, poor.id, poorNow.plan.hash)).status === 202);
  const poorDone = await waitDone(u11, poor.id);
  await sleep(500);
  const poorFinal = await getB(u11, poor.id);
  check('(回歸)第一次確認被拒後再確認:成功,且訂位費確實結算(不是退回)', poorDone?.status === 'succeeded' && execCharge(poorFinal)?.state === 'settled', `${poorDone?.status} / ${execCharge(poorFinal)?.state}`);
  const poorLedger = (await api('GET', '/points/ledger', { token: u11.token })).json.items;
  check('(回歸)點數明細有這筆訂位費', poorLedger.some((l: any) => l.ref_type === 'booking' && l.amount === -3));

  // ================================================================== 11. 對帳
  section('11. 對帳:沒有卡住的預扣 / 沒有未決的扣點');
  await sleep(1500);
  const stats = (await (await fetch(`${BILLING}/internal/stats`, { headers: { 'x-internal-token': INTERNAL } })).json()) as any;
  const open = await pool.query(`SELECT state, count(*)::int AS n FROM charges WHERE state NOT IN ('settled','released') GROUP BY state`);
  check('booking 的 charges 沒有未決狀態', open.rows.length === 0, JSON.stringify(open.rows));
  const heldSum = await pool.query(`SELECT coalesce(sum(amount),0)::int AS n FROM charges WHERE state IN ('holding','held')`);
  check('沒有殘留的預扣', heldSum.rows[0].n === 0 && Number(stats.active_holds) === 0, `billing active_holds=${stats.active_holds}`);

  await pool.end();
  console.log(`\n${failed === 0 ? '🎉 全部通過' : '💥 有失敗'}:${passed} 通過 / ${failed} 失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('腳本錯誤:', e);
  process.exit(2);
});
