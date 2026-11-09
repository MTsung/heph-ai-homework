import { z } from 'zod';
import type { LlmProvider } from '../../../../shared/llm';
import type { Logger } from '../../../../shared/log';
import type { Candidate, InfoField, Patch, Slots } from './types';

// ============================================================================ 台北時間的日期工具
const TZ_MS = 8 * 3600_000; // 台灣沒有日光節約時間,固定 UTC+8
const pad = (n: number) => String(n).padStart(2, '0');

interface Ymd {
  y: number;
  m: number;
  d: number;
  dow: number; // 0 = 週日
}

export function taipei(now: Date): Ymd {
  const t = new Date(now.getTime() + TZ_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}
export const toDateStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const todayStr = (now: Date) => {
  const t = taipei(now);
  return toDateStr(t.y, t.m, t.d);
};
function plusDays(base: Ymd, n: number): string {
  const t = new Date(Date.UTC(base.y, base.m - 1, base.d + n));
  return toDateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export const weekdayOf = (date: string) => WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;

export function isValidDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}
export const isValidTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// ============================================================================ 是不是訂位需求
/**
 * 第一道關卡:純規則、免費、毫秒完成。一般聊天不會因此多花一次模型呼叫或點數。
 * 取向是「寧可漏判也不要誤判」:漏判的使用者只是照一般聊天走;誤判會讓人進到訂位流程。
 */
const INTENT = /(訂位|訂桌|訂座|預訂|預約(?!.{0,4}(?:醫|診|門診|按摩|美容|美髮|剪髮))|幫我訂|訂.{0,6}(餐廳|餐館|料理|燒肉|火鍋|壽司|居酒屋|牛排|拉麵|吃到飽)|book(?:ing)?\s+(?:a\s+)?(?:table|restaurant)|reserve\s+a\s+table)/i;
const NOT_INTENT = /(取消|怎麼訂|如何訂|怎樣訂|要怎麼|不用訂|不要訂)/;

export function isBookingIntent(text: string): boolean {
  return INTENT.test(text) && !NOT_INTENT.test(text);
}

// ============================================================================ 規則式解析
const CN = '零〇一二兩三四五六七八九十';
const DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function num(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const i = s.indexOf('十');
  if (i < 0) return DIGIT[s] ?? NaN;
  const tens = i === 0 ? 1 : (DIGIT[s.slice(0, i)] ?? NaN);
  const ones = i === s.length - 1 ? 0 : (DIGIT[s.slice(i + 1)] ?? NaN);
  return tens * 10 + ones;
}

const WD: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 取出第一個符合的片段,並把它從文字中抹掉(換成空白),避免被後面的規則重複解讀 */
function take(text: string, re: RegExp): { m: RegExpExecArray | null; rest: string } {
  const m = re.exec(text);
  return m ? { m, rest: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}` } : { m: null, rest: text };
}

export function parseDate(text: string, now: Date): { date?: string; rest: string } {
  const t = taipei(now);
  let r = take(text, /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (r.m) {
    const d = toDateStr(+r.m[1]!, +r.m[2]!, +r.m[3]!);
    if (isValidDate(d)) return { date: d, rest: r.rest };
  }
  r = take(text, /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/);
  if (!r.m) r = take(text, /(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d:])/);
  if (r.m) {
    let y = t.y;
    let d = toDateStr(y, +r.m[1]!, +r.m[2]!);
    if (isValidDate(d) && d < todayStr(now)) d = toDateStr(++y, +r.m[1]!, +r.m[2]!); // 已經過了 → 當作明年
    if (isValidDate(d)) return { date: d, rest: r.rest };
  }
  r = take(text, /(大後天|後天|明天|明晚|明日|今天|今晚|今日)/);
  if (r.m) {
    const k = r.m[1]!;
    const n = k === '大後天' ? 3 : k === '後天' ? 2 : k.startsWith('明') ? 1 : 0;
    return { date: plusDays(t, n), rest: r.rest };
  }
  // 「週五」「這週五」「下週五」。台灣習慣週一為一週的開頭。
  //   這/本週X、單說週X:今天起(含今天)最近的那個星期X
  //   下週X:下一個「週一到週日」那一週的星期X;下下週X 再多一週
  r = take(text, /(下下|下個|下|這個|這|本)?\s*(?:週|周|星期|禮拜)([一二三四五六日天])/);
  if (r.m) {
    const target = WD[r.m[2]!]!;
    const prefix = r.m[1] ?? '';
    const sinceMonday = (t.dow + 6) % 7;
    let offset: number;
    if (prefix.startsWith('下下')) offset = 14 - sinceMonday + ((target + 6) % 7);
    else if (prefix.startsWith('下')) offset = 7 - sinceMonday + ((target + 6) % 7);
    else offset = (target - t.dow + 7) % 7;
    return { date: plusDays(t, offset), rest: r.rest };
  }
  return { rest: text };
}

const PERIOD = '(早上|上午|中午|下午|傍晚|晚上|晚間|晚)';

function applyPeriod(h: number, period?: string): number {
  if (h > 23) return NaN;
  switch (period) {
    case '早上':
    case '上午':
      return h === 12 ? 0 : h;
    case '中午':
      return h < 11 ? h + 12 : h;
    case '下午':
    case '傍晚':
    case '晚上':
    case '晚間':
    case '晚':
      return h < 12 ? h + 12 : h;
    default:
      // 沒說上午下午:吃飯的情境,1~10 點當作下午(7 點 = 19:00)
      return h >= 1 && h <= 10 ? h + 12 : h;
  }
}

export function parseTime(text: string): { time?: string; rest: string } {
  const out = (h: number, m: number, rest: string) =>
    Number.isFinite(h) && h < 24 && m < 60 ? { time: `${pad(h)}:${pad(m)}`, rest } : { rest: text };

  let r = take(text, new RegExp(`${PERIOD}?\\s*(?<![\\d])(\\d{1,2}):(\\d{2})\\s*(am|pm)?`, 'i'));
  if (r.m) {
    const h = +r.m[2]!;
    const ap = r.m[4]?.toLowerCase();
    let hh: number;
    if (ap === 'pm') hh = h < 12 ? h + 12 : h;
    else if (ap === 'am') hh = h === 12 ? 0 : h;
    else hh = applyPeriod(h, r.m[1]);
    return out(hh, +r.m[3]!, r.rest);
  }
  r = take(text, new RegExp(`${PERIOD}?\\s*(\\d{1,2}|[${CN}]{1,3})\\s*[點点時时](?:\\s*整)?(?:\\s*(半)|\\s*(\\d{1,2})\\s*分)?`));
  if (r.m) return out(applyPeriod(num(r.m[2]!), r.m[1]), r.m[3] ? 30 : r.m[4] ? +r.m[4] : 0, r.rest);
  r = take(text, /(?<!\d)(\d{1,2})\s*(am|pm)\b/i);
  if (r.m) {
    let h = +r.m[1]!;
    const pm = r.m[2]!.toLowerCase() === 'pm';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return out(h, 0, r.rest);
  }
  return { rest: text };
}

export function parsePartySize(text: string): { n?: number; rest: string } {
  // 阿拉伯數字可接「個」;中文數字必須接「位 / 人 / 名」(避免把「訂一個位子」的「一個」當成 1 人)
  let r = take(text, /(?<![\d:])(\d{1,2})\s*(?:個人|位|人|名|個)/);
  if (!r.m) r = take(text, new RegExp(`([${CN}]{1,3})\\s*(?:個人|位|人|名)`));
  if (r.m) {
    const n = num(r.m[1]!);
    if (Number.isInteger(n) && n >= 1 && n <= 50) return { n, rest: r.rest };
  }
  return { rest: text };
}

export const normalizePhone = (s: string): string | undefined => {
  const d = s.replace(/[\s-]/g, '').replace(/^\+886/, '0');
  return /^09\d{8}$/.test(d) ? d : undefined;
};
const PHONE_RE = /(?<!\d)(?:\+886[\s-]?)?0?9\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
export const isEmail = (s: string) => new RegExp(`^${EMAIL_RE.source}$`).test(s);

const DISTRICTS = [
  '中正區', '大同區', '中山區', '松山區', '大安區', '萬華區', '信義區', '士林區', '北投區', '內湖區', '南港區', '文山區',
  '板橋區', '新莊區', '中和區', '永和區', '三重區', '新店區', '淡水區', '汐止區', '蘆洲區',
];

/** 料理 → 標準名稱。順序有意義:較具體的(燒肉)放在較籠統的(日式)前面 */
const CUISINES: Array<[string, RegExp]> = [
  ['燒肉', /燒肉|烤肉/],
  ['日式', /日式|日本|壽司|拉麵|居酒屋|割烹|丼|天婦羅|和食|懷石|生魚片/],
  ['義式', /義式|義大利|披薩|pizza|pasta|燉飯/i],
  ['火鍋', /火鍋|涮涮鍋|麻辣鍋/],
  ['中式', /中式|中菜|港式|粵式|川菜|江浙|小籠包|港點|飲茶/],
  ['台菜', /台菜|臺菜|台式|小吃|牛肉麵|熱炒|合菜/],
  ['西餐', /西餐|牛排|法式|美式|排餐/],
  ['泰式', /泰式|泰國/],
  ['韓式', /韓式|韓國|韓餐/],
  ['素食', /素食|蔬食/],
];
export const CUISINE_NAMES = CUISINES.map(([n]) => n);

// 去掉這些客套 / 動詞後,剩下的中文才可能是店名
const STOP = [
  '幫我', '幫忙', '麻煩', '拜託', '謝謝', '請問', '我想要', '我想', '我要', '想要', '可以', '能不能', '是否',
  '訂一個位子', '訂個位子', '訂一個位', '訂個位', '位子', '座位', '位置', '訂位', '訂桌', '訂座', '預訂', '預約', '訂',
  '餐廳', '餐館', '料理', '晚餐', '午餐', '吃飯', '用餐', '聚餐', '一下', '一間', '一家', '那間', '那家', '我們', '大家',
  '電話', '手機', '信箱', '訂位人', '名字', '姓名', '聯絡', '改成', '改為', '換成', '調成', '是想', '是要', '想訂', '要訂',
  '好的', '可以的', '沒問題', '不用', '的', '在', '到', '去', '吃', '和', '跟', '與', '我', '你', '嗎', '吧', '呢', '啊', '喔', '哦', '呀', '幫', '要', '有',
  '是', '改', '換', '好', '對', '都', '也', '就', '再', '先', '給', '讓', '把',
].sort((a, b) => b.length - a.length);

const AREA_RE = new RegExp(DISTRICTS.join('|'));

export interface NluCtx {
  now: Date;
  slots: Slots;
  /** 系統剛剛在等使用者提供的資料(用來解讀「王小明」「0912…」這種單獨的回答) */
  expect: InfoField[];
  /** 是否把剩下的字當成店名(只有在還沒選定餐廳時才合理) */
  allowName: boolean;
}

export function parseWithRules(text: string, ctx: NluCtx): Patch {
  const patch: Patch = {};
  let rest = text;
  const contact: NonNullable<Patch['contact']> = {};

  const email = take(rest, EMAIL_RE);
  if (email.m) {
    contact.email = email.m[0];
    rest = email.rest;
  }
  const phone = take(rest, PHONE_RE);
  if (phone.m) {
    const p = normalizePhone(phone.m[0].startsWith('9') ? `0${phone.m[0]}` : phone.m[0]);
    if (p) contact.phone = p;
    rest = phone.rest;
  }
  // 用「最短且後面接著分隔」的寫法,避免把後面的「電話」兩個字也吃進姓名;不收「我是」(「我是想訂位」不是名字)
  const name = take(
    rest,
    /(?:我叫|姓名|名字|訂位姓名|訂位人|聯絡人)\s*[:：]?\s*([\u4e00-\u9fffA-Za-z·]{2,12}?)(?=電話|手機|信箱|email|[\s,，。.、;；:：\d]|$)/i,
  );
  if (name.m) {
    contact.name = name.m[1]!;
    rest = name.rest;
  }

  const d = parseDate(rest, ctx.now);
  if (d.date) patch.date = d.date;
  rest = d.rest;
  const t = parseTime(rest);
  if (t.time) patch.time = t.time;
  rest = t.rest;
  const p = parsePartySize(rest);
  if (p.n) patch.party_size = p.n;
  rest = p.rest;

  const area = take(rest, AREA_RE);
  if (area.m) {
    patch.area = area.m[0];
    rest = area.rest;
  }
  // 料理與店名:先把客套話 / 標點去掉再斷成詞。
  //   整個詞「只有」料理關鍵字(日式、燒肉)→ 是料理類型
  //   詞裡除了關鍵字還有別的字(老張牛肉麵、慢熱義式餐酒館)→ 整個詞是店名,不能把裡面的關鍵字拆出來當料理
  const tokens = stripFiller(rest).split(/\s+/).filter(Boolean);
  const nameTokens: string[] = [];
  for (const tok of tokens) {
    let residual = tok;
    let found: string | undefined;
    for (const [cuisine, re] of CUISINES) {
      const g = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');
      if (g.test(residual)) {
        found ??= cuisine;
        residual = residual.replace(new RegExp(re.source, g.flags), '');
      }
    }
    if (found && residual.length === 0) patch.cuisine ??= found;
    else if (/[\u4e00-\u9fffA-Za-z]/.test(tok)) nameTokens.push(tok);
  }

  // 系統正在等某個欄位時,單獨的短回答也算數
  const bare = text.trim();
  if (ctx.expect.some((f) => f.key === 'contact.name') && !contact.name && /^[\u4e00-\u9fff·]{2,5}$/.test(bare)) contact.name = bare;
  const extra: Record<string, string> = {};
  for (const f of ctx.expect) {
    if (f.key.startsWith('extra.') && f.options) {
      const hit = f.options.find((o) => text.includes(o));
      if (hit) extra[f.key.slice(6)] = hit;
    }
  }
  if (Object.keys(contact).length) patch.contact = contact;
  if (Object.keys(extra).length) patch.extra = extra;

  if (ctx.allowName) {
    const left = nameTokens.join(' ');
    const minLen = patch.area || patch.cuisine ? 3 : 2; // 已經給了地區 / 料理,剩下很短的字多半是形容詞
    if (left.replace(/\s/g, '').length >= minLen && left.length <= 20) patch.restaurant_query = left;
  }
  return patch;
}

/** 去掉客套話與標點,只留下可能是店名 / 料理的字,詞與詞之間用空白隔開 */
function stripFiller(text: string): string {
  let left = text.replace(/e-?mail|mail/gi, ' ');
  for (const w of STOP) left = left.split(w).join(' ');
  return left.replace(/[\s,，。.、;；:：!！?？~～()（）「」"'\d]+/g, ' ').trim();
}

/** 使用者用文字選擇:「第二個」「2」「櫻花亭」 */
export function pickCandidate(text: string, options: Array<{ id: string; name: string }>): string | null {
  const t = text.trim();
  const ord = /第\s*(\d{1,2}|[零〇一二兩三四五六七八九十]{1,3})\s*(?:個|家|間|號|名|項)?/.exec(t) ?? /^\s*(\d{1,2})\s*[號.、]?\s*$/.exec(t);
  if (ord) {
    const n = num(ord[1]!);
    if (n >= 1 && n <= options.length) return options[n - 1]!.id;
  }
  const hits = options.filter((o) => t.includes(o.name) || (t.length >= 2 && o.name.includes(t)));
  return hits.length === 1 ? hits[0]!.id : null;
}

// ============================================================================ LLM 解析
const optStr = (max: number) => z.string().max(max).nullish();
const llmOut = z.object({
  restaurant_query: optStr(40),
  area: optStr(10),
  cuisine: optStr(10),
  date: optStr(10),
  time: optStr(5),
  party_size: z.number().int().min(1).max(50).nullish(),
  contact: z.object({ name: optStr(40), phone: optStr(30), email: optStr(80) }).nullish(),
  notes: optStr(200),
});

/** 模型的輸出一律當成不可信資料:格式、範圍、是否過期都重新檢查,不合格的欄位直接丟掉 */
function sanitize(o: z.infer<typeof llmOut>, now: Date): Patch {
  const p: Patch = {};
  if (o.restaurant_query?.trim()) p.restaurant_query = o.restaurant_query.trim();
  if (o.area && /^[\u4e00-\u9fff]{2}區$/.test(o.area.trim())) p.area = o.area.trim();
  if (o.cuisine && CUISINE_NAMES.includes(o.cuisine.trim())) p.cuisine = o.cuisine.trim();
  if (o.date && isValidDate(o.date) && o.date >= todayStr(now)) p.date = o.date;
  if (o.time && isValidTime(o.time)) p.time = o.time;
  if (o.party_size) p.party_size = o.party_size;
  if (o.notes?.trim()) p.notes = o.notes.trim();
  const c: NonNullable<Patch['contact']> = {};
  if (o.contact?.name?.trim()) c.name = o.contact.name.trim();
  const phone = o.contact?.phone ? normalizePhone(o.contact.phone) : undefined;
  if (phone) c.phone = phone;
  if (o.contact?.email && isEmail(o.contact.email.trim())) c.email = o.contact.email.trim();
  if (Object.keys(c).length) p.contact = c;
  return p;
}

function systemPrompt(now: Date, ctx: NluCtx): string {
  const today = todayStr(now);
  const known = {
    restaurant: ctx.slots.restaurant?.name,
    area: ctx.slots.area,
    cuisine: ctx.slots.cuisine,
    date: ctx.slots.date,
    time: ctx.slots.time,
    party_size: ctx.slots.party_size,
  };
  return `你是訂餐廳助手的「資訊抽取器」。從使用者的話抽出訂位資訊,只輸出一個 JSON 物件,不要說明、不要 markdown。
今天是 ${today}(星期${weekdayOf(today)}),時區台北。沒提到的欄位填 null,不要猜測或編造。
欄位:
- restaurant_query: 使用者「明確指名」的某一家店名。只說地區或料理類型時填 null
- area: 地區,格式「XX區」,例如 信義區
- cuisine: 只能是 ${CUISINE_NAMES.join("/")} 其中之一,否則 null
- date: YYYY-MM-DD。「這週五」是今天起(含今天)最近的星期五;「下週五」是下一個週一至週日那一週的星期五
- time: 24 小時制 HH:MM。沒說上午下午時,1~10 點當作下午
- party_size: 整數人數
- contact: {"name":姓名,"phone":台灣手機，只能是09xxxxxxxx或+8869xxxxxxxx,"email":信箱}
- notes: 特殊需求(慶生、靠窗、兒童椅…)
目前已知:${JSON.stringify(known)}
只需輸出使用者「這一則訊息」新提供或更正的內容。`;
}

export class Nlu {
  /** llm 為 null(或只有 mock)時只用規則 */
  constructor(
    private readonly llm: LlmProvider | null,
    private readonly log: Logger,
    private readonly timeoutMs = 8000,
  ) {}

  get mode(): 'llm' | 'rules' {
    return this.llm ? 'llm' : 'rules';
  }

  async understand(text: string, ctx: NluCtx): Promise<{ patch: Patch; source: 'llm' | 'rules' }> {
    if (this.llm) {
      try {
        return { patch: await this.viaLlm(text, ctx), source: 'llm' };
      } catch (e) {
        // 模型不可用 / 輸出不合法:退回規則,使用者不會因此卡住
        this.log.warn({ err: (e as Error).message }, 'llm understanding failed, falling back to rules');
      }
    }
    return { patch: parseWithRules(text, ctx), source: 'rules' };
  }

  private async viaLlm(text: string, ctx: NluCtx): Promise<Patch> {
    const ac = AbortSignal.timeout(this.timeoutMs);
    let raw = '';
    const it = this.llm!.stream({
      messages: [
        { role: 'system', content: systemPrompt(ctx.now, ctx) },
        { role: 'user', content: text.slice(0, 500) },
      ],
      signal: ac,
      maxOutputTokens: 300,
      persona: { slug: 'booking', name: 'booking' },
    });
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      raw += r.value;
      if (raw.length > 4000) throw new Error('模型輸出過長');
    }
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型輸出不是 JSON');
    const parsed = llmOut.safeParse(JSON.parse(raw.slice(a, b + 1)));
    if (!parsed.success) throw new Error(`模型輸出格式不符:${parsed.error.issues[0]?.message}`);
    const patch = sanitize(parsed.data, ctx.now);
    if (!ctx.allowName) delete patch.restaurant_query;
    return patch;
  }
}

export type { Candidate };
