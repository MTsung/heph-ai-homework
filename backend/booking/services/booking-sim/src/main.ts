// 訂位世界的模擬器(沒有真實平台可用時,用它驗證整條流程與各種異常)。它同時扮演三個角色:
//
//   1. 假的 Google 搜尋      GET  /search/places           找餐廳
//                            GET  /search/booking-link     「店名 訂位」的搜尋結果:有沒有訂位連結
//   2. 餐廳自家的訂位網頁    GET  /r/:id/reserve?date=&party=   HTML 表單(欄位、必填各店不同)
//                            POST /r/:id/reserve                送出表單,回傳 HTML 結果頁
//   3. 合作的訂位平台 API    GET  /platform/v1/restaurants/:id/availability
//                            POST /platform/v1/reservations     需帶 Idempotency-Key
//
// 除錯:GET /__debug/reservations 看「對方實際收到哪些訂位」(測試用來確認:只送出使用者確認的那一筆、沒有重複送)
//       POST /__debug/reset 清空
//
// 這是模擬器:資料存在記憶體,重啟就清空;不做任何驗證 / 授權。
import { byId, RESTAURANTS, type Restaurant } from './data';

const PORT = Number(process.env.PORT ?? 9100);
/** booking 服務看到的本服務位址(搜尋結果裡的連結要讓它連得到) */
const PUBLIC_URL = (process.env.SIM_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
/** 網頁表單送出後,對方「處理」要多久。模擬真實網站的延遲,也讓「同時處理上限」看得到效果 */
const SUBMIT_DELAY_MS = Number(process.env.SIM_SUBMIT_DELAY_MS ?? 2500);
const SLOW_MS = Number(process.env.SIM_SLOW_MS ?? 8000);
/** dropped:訂位已經成功寫入,但回應卡很久才回(比 booking 的逾時還久) */
const DROPPED_MS = Number(process.env.SIM_DROPPED_MS ?? 60_000);

interface Reservation {
  code: string;
  restaurant_id: string;
  date: string;
  time: string;
  party_size: number;
  name: string;
  phone?: string;
  email?: string;
  extra: Record<string, string>;
  via: 'web_form' | 'platform_api';
  idempotency_key?: string;
  at: string;
}

const reservations: Reservation[] = [];
const tokens = new Map<string, number>(); // 表單 token → 到期時間
const platformByKey = new Map<string, Reservation>(); // Idempotency-Key → 當初的結果
const platformSeen = new Set<string>(); // flaky_platform:這個 key 是否已經失敗過一次

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const html = (body: string, status = 200) =>
  new Response(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>訂位</title></head><body>${body}</body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const code = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const validDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

function taken(r: Restaurant, date: string, time: string): number {
  return reservations.filter((x) => x.restaurant_id === r.id && x.date === date && x.time === time).length;
}
function availableTimes(r: Restaurant, date: string): string[] {
  if (r.closedWeekday !== undefined && weekday(date) === r.closedWeekday) return [];
  if (r.behavior === 'full') return r.slots; // 客滿的店在表單上看起來還有位,送出才發現(模擬資料不同步)
  return r.slots.filter((t) => taken(r, date, t) < r.capacity);
}

// ============================================================================ 1. 假的 Google
/** 店名搜尋要像真的搜尋引擎一樣寬鬆:忽略空白,容許漏字(查詢字依序出現在店名裡即可,至少 3 個字) */
function nameMatches(name: string, query: string): boolean {
  const n = name.replace(/\s+/g, '');
  const k = query.replace(/\s+/g, '');
  if (n.includes(k) || k.includes(n)) return true;
  if (k.length < 3) return false;
  let i = 0;
  for (const ch of n) if (ch === k[i]) i++;
  return i === k.length;
}

function searchPlaces(url: URL): Response {
  const q = url.searchParams.get('q')?.trim();
  const district = url.searchParams.get('district')?.trim();
  const cuisine = url.searchParams.get('cuisine')?.trim();
  const items = RESTAURANTS.filter(
    (r) =>
      (!q || nameMatches(r.name, q)) &&
      (!district || r.district === district) &&
      (!cuisine || r.cuisine === cuisine),
  )
    .sort((a, b) => b.rating - a.rating)
    .map((r) => ({
      place_id: r.id,
      name: r.name,
      city: r.city,
      district: r.district,
      cuisine: r.cuisine,
      address: r.address,
      phone: r.phone,
      rating: r.rating,
    }));
  return Response.json({ items });
}

/** 模擬「搜尋 <店名> 訂位」的結果:有網頁表單就回連結,有合作平台就回平台代號,都沒有就是空陣列 */
function bookingLink(url: URL): Response {
  const r = byId.get(url.searchParams.get('place_id') ?? '');
  if (!r || r.channel === 'none') return Response.json({ results: [] });
  if (r.channel === 'web_form') {
    return Response.json({ results: [{ kind: 'web_form', title: `${r.name} 線上訂位`, url: `${PUBLIC_URL}/r/${r.id}/reserve` }] });
  }
  return Response.json({
    results: [{ kind: 'platform_api', title: `${r.name}(合作平台)`, platform: 'simbook', platform_restaurant_id: r.id }],
  });
}

// ============================================================================ 2. 餐廳網頁表單
function formPage(r: Restaurant, date: string, party: number, times: string[]): Response {
  const closed = r.closedWeekday !== undefined && weekday(date) === r.closedWeekday;
  const header = `<h1>${esc(r.name)} 線上訂位</h1>`;
  if (closed) return html(`${header}<p class="notice" data-code="CLOSED">${esc(date)} 公休,無法訂位。</p>`);
  if (times.length === 0) return html(`${header}<p class="notice" data-code="NO_AVAILABILITY">${esc(date)} 已無空位。</p>`);

  const token = crypto.randomUUID();
  tokens.set(token, Date.now() + 10 * 60_000);
  const partyOpts = Array.from({ length: r.maxParty }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === party ? ' selected' : ''}>${n} 位</option>`)
    .join('');
  const timeOpts = times.map((t) => `<option value="${t}">${t}</option>`).join('');
  const extras = r.extra
    .map(
      (e) => `<p><label for="${e.name}">${esc(e.label)}</label>
        <select id="${e.name}" name="${e.name}" required><option value="">請選擇</option>${e.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></p>`,
    )
    .join('');
  return html(`${header}
    <form id="reservation-form" method="post" action="/r/${r.id}/reserve">
      <input type="hidden" name="form_token" value="${token}">
      <p><label for="date">日期</label><input id="date" name="date" type="date" value="${esc(date)}" required></p>
      <p><label for="party_size">人數</label><select id="party_size" name="party_size" required>${partyOpts}</select></p>
      <p><label for="time">時段</label><select id="time" name="time" required><option value="">請選擇</option>${timeOpts}</select></p>
      <p><label for="name">訂位姓名</label><input id="name" name="name" type="text" required></p>
      <p><label for="phone">聯絡電話</label><input id="phone" name="phone" type="tel"${r.requirePhone ? ' required' : ''}></p>
      <p><label for="email">電子郵件</label><input id="email" name="email" type="email"${r.requireEmail ? ' required' : ''}></p>
      ${extras}
      <p><label for="notes">備註</label><textarea id="notes" name="notes"></textarea></p>
      <button type="submit">送出訂位</button>
    </form>`);
}

const fail = (c: string, msg: string) => html(`<div id="result" class="error" data-code="${c}"><p>${esc(msg)}</p></div>`);

async function submitForm(r: Restaurant, req: Request): Promise<Response> {
  const f = new URLSearchParams(await req.text());
  const token = f.get('form_token') ?? '';
  const exp = tokens.get(token);
  tokens.delete(token); // 單次有效:重放同一張表單會被拒絕
  if (!exp || exp < Date.now()) return fail('BAD_TOKEN', '表單已失效,請重新整理頁面後再試。');

  const date = f.get('date');
  const time = f.get('time') ?? '';
  const party = Number(f.get('party_size'));
  const name = (f.get('name') ?? '').trim();
  const phone = (f.get('phone') ?? '').trim();
  const email = (f.get('email') ?? '').trim();
  if (!validDate(date) || !r.slots.includes(time) || !Number.isInteger(party) || party < 1) return fail('INVALID_INPUT', '日期、時段或人數不正確。');
  if (party > r.maxParty) return fail('PARTY_TOO_LARGE', `本店單筆訂位最多 ${r.maxParty} 位。`);
  if (!name) return fail('MISSING_FIELD', '請填寫訂位姓名。');
  if (r.requirePhone && !phone) return fail('MISSING_FIELD', '請填寫聯絡電話。');
  if (r.requireEmail && !email) return fail('MISSING_FIELD', '請填寫電子郵件。');
  const extra: Record<string, string> = {};
  for (const e of r.extra) {
    const v = f.get(e.name) ?? '';
    if (!e.options.includes(v)) return fail('MISSING_FIELD', `請選擇${e.label}。`);
    extra[e.name] = v;
  }

  if (r.behavior === 'full' || !availableTimes(r, date).includes(time)) return fail('FULL', '抱歉,該時段已客滿。');

  const rec: Reservation = {
    code: code('WF'),
    restaurant_id: r.id,
    date,
    time,
    party_size: party,
    name,
    phone: phone || undefined,
    email: email || undefined,
    extra,
    via: 'web_form',
    at: new Date().toISOString(),
  };

  if (r.behavior === 'dropped') {
    // 訂位其實已經成立,但回應遲遲不來:呼叫端逾時後無從得知結果,這正是「結果未知」的情境
    reservations.push(rec);
    await sleep(DROPPED_MS);
  } else {
    await sleep(r.behavior === 'slow' ? SLOW_MS : SUBMIT_DELAY_MS);
    reservations.push(rec);
  }
  return html(`<div id="result" class="success"><p>訂位成功!</p><p>訂位代號:<strong id="confirmation-code">${rec.code}</strong></p></div>`);
}

// ============================================================================ 3. 合作平台 API
const apiError = (status: number, c: string, message: string) => Response.json({ error: { code: c, message } }, { status });

function platformAvailability(r: Restaurant, url: URL): Response {
  const date = url.searchParams.get('date');
  if (!validDate(date)) return apiError(400, 'INVALID_REQUEST', 'date 格式需為 YYYY-MM-DD');
  return Response.json({
    restaurant_id: r.id,
    date,
    times: availableTimes(r, date),
    required_fields: ['name', ...(r.requirePhone ? ['phone'] : []), ...(r.requireEmail ? ['email'] : [])],
    extra_fields: r.extra,
    max_party: r.maxParty,
    closed: r.closedWeekday !== undefined && weekday(date) === r.closedWeekday,
  });
}

async function platformReserve(req: Request): Promise<Response> {
  const key = req.headers.get('idempotency-key');
  if (!key) return apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '需要 Idempotency-Key 標頭');
  const body = (await req.json().catch(() => null)) as {
    restaurant_id?: string;
    date?: string;
    time?: string;
    party_size?: number;
    contact?: { name?: string; phone?: string; email?: string };
    extra?: Record<string, string>;
  } | null;
  const r = body?.restaurant_id ? byId.get(body.restaurant_id) : undefined;
  if (!body || !r || r.channel !== 'platform_api') return apiError(404, 'RESTAURANT_NOT_FOUND', '找不到合作餐廳');

  // 冪等:同一個 key 再來一次,回傳第一次的結果,不會多訂一筆
  const prior = platformByKey.get(key);
  if (prior) return Response.json({ reservation_no: prior.code, replayed: true }, { status: 200 });

  if (!validDate(body.date ?? null) || !body.time || !r.slots.includes(body.time) || !Number.isInteger(body.party_size))
    return apiError(422, 'INVALID_REQUEST', '日期、時段或人數不正確');
  if (body.party_size! > r.maxParty) return apiError(422, 'PARTY_TOO_LARGE', `單筆最多 ${r.maxParty} 位`);
  if (!body.contact?.name) return apiError(422, 'MISSING_FIELD', '缺少訂位姓名');
  if (r.requirePhone && !body.contact.phone) return apiError(422, 'MISSING_FIELD', '缺少聯絡電話');
  if (r.requireEmail && !body.contact.email) return apiError(422, 'MISSING_FIELD', '缺少電子郵件');
  if (!availableTimes(r, body.date!).includes(body.time)) return apiError(409, 'SLOT_FULL', '該時段已客滿');

  await sleep(300);
  const rec: Reservation = {
    code: code('PF'),
    restaurant_id: r.id,
    date: body.date!,
    time: body.time,
    party_size: body.party_size!,
    name: body.contact.name,
    phone: body.contact.phone,
    email: body.contact.email,
    extra: body.extra ?? {},
    via: 'platform_api',
    idempotency_key: key,
    at: new Date().toISOString(),
  };
  reservations.push(rec);
  platformByKey.set(key, rec);

  // flaky_platform:第一次收單成功,但回 503(呼叫端不知道有沒有成功)。帶同一個 key 重試就能拿到結果
  if (r.behavior === 'flaky_platform' && !platformSeen.has(key)) {
    platformSeen.add(key);
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', '服務暫時無法使用');
  }
  return Response.json({ reservation_no: rec.code }, { status: 201 });
}

// ============================================================================ 路由
Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/healthz') return new Response('ok');
    if (p === '/search/places') return searchPlaces(url);
    if (p === '/search/booking-link') return bookingLink(url);

    if (p === '/__debug/reservations') return Response.json({ items: reservations });
    if (p === '/__debug/reset' && req.method === 'POST') {
      reservations.length = 0;
      platformByKey.clear();
      platformSeen.clear();
      return Response.json({ ok: true });
    }

    let m = p.match(/^\/r\/([\w-]+)\/reserve$/);
    if (m) {
      const r = byId.get(m[1]!);
      if (!r || r.channel !== 'web_form') return html('<p>找不到這家餐廳</p>', 404);
      if (req.method === 'POST') return submitForm(r, req);
      const date = url.searchParams.get('date');
      const party = Number(url.searchParams.get('party') ?? 2);
      const d = validDate(date) ? date : new Date().toISOString().slice(0, 10);
      return formPage(r, d, Number.isInteger(party) && party >= 1 ? party : 2, availableTimes(r, d));
    }

    m = p.match(/^\/platform\/v1\/restaurants\/([\w-]+)\/availability$/);
    if (m) {
      const r = byId.get(m[1]!);
      if (!r || r.channel !== 'platform_api') return apiError(404, 'RESTAURANT_NOT_FOUND', '找不到合作餐廳');
      return platformAvailability(r, url);
    }
    if (p === '/platform/v1/reservations' && req.method === 'POST') return platformReserve(req);

    return new Response('not found', { status: 404 });
  },
});
console.log(`booking-sim listening on :${PORT}`);
