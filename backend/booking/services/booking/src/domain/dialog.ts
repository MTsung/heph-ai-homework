import { AppError } from '@chat-app/shared/errors';
import type { ChannelRegistry } from '../integrations/channels';
import { isValidDate, isValidTime, todayStr, weekdayOf } from './nlu';
import type { Place, SearchProvider } from '../integrations/search';
import {
  ChannelError,
  type Candidate,
  type Contact,
  type InfoField,
  type Patch,
  type Pending,
  type Plan,
  type RestaurantRef,
  type Slots,
} from '../types';

/**
 * 對話流程管理:給定「目前累積的條件」,決定下一步 —— 該問使用者什麼,或是已經可以出方案。
 *
 * 這是整個服務裡決定「要問什麼、能不能出方案」的唯一地方。NLU(規則或 LLM)只負責把使用者的話變成
 * 條件(Patch),流程完全由這裡的程式規則決定。所以模型寫錯、亂說,最壞只是少抓到一個欄位,
 * 不可能跳過檢查直接產生方案,更不可能影響「送出什麼」。
 *
 * 每次都從頭重算(搜尋、查店家表單),不依賴上一輪的結果。這讓它沒有隱藏狀態:
 * 使用者隔一天回來、換條件、重送同一則訊息,得到的都是依「現在」的資料算出的下一步。
 */
export interface DialogPorts {
  search: SearchProvider;
  channels: ChannelRegistry;
  now: Date;
  /** 方案確認期限(秒),寫進提示文字 */
  planTtlSec: number;
  /** 預訂成功才扣的點數,寫進提示文字 */
  bookCost: number;
}

export interface Step {
  slots: Slots;
  status: 'collecting' | 'awaiting_confirmation';
  pending: Pending;
  candidates: Candidate[] | null;
  plan: Plan | null;
  message: string;
}

const MAX_CANDIDATES = 5;
const INSPECT_TIMEOUT_MS = 6000;

// ============================================================================ 套用使用者提供的資料
export function applyPatch(prev: Slots, patch: Patch, now: Date): { slots: Slots; notes: string[] } {
  const s: Slots = structuredClone(prev);
  const notes: string[] = [];

  // 換了找店條件(店名 / 地區 / 料理)→ 原本選的餐廳作廢,重新找
  const resetRestaurant = () => {
    delete s.restaurant;
    delete s.extra;
  };
  if (patch.restaurant_query !== undefined && patch.restaurant_query !== s.restaurant?.name) {
    s.restaurant_query = patch.restaurant_query;
    resetRestaurant();
  }
  if (patch.area !== undefined && patch.area !== s.area) {
    s.area = patch.area;
    if (s.restaurant) {
      delete s.restaurant_query;
      resetRestaurant();
    }
  }
  if (patch.cuisine !== undefined && patch.cuisine !== s.cuisine) {
    s.cuisine = patch.cuisine;
    if (s.restaurant) {
      delete s.restaurant_query;
      resetRestaurant();
    }
  }

  if (patch.date !== undefined) {
    if (isValidDate(patch.date) && patch.date >= todayStr(now)) s.date = patch.date;
    else notes.push('這個日期已經過了或格式不對,請再給我一個日期。\n');
  }
  if (patch.time !== undefined && isValidTime(patch.time)) s.time = patch.time;
  if (patch.party_size !== undefined && patch.party_size >= 1 && patch.party_size <= 50) s.party_size = patch.party_size;
  if (patch.notes !== undefined) s.notes = patch.notes.slice(0, 200);
  if (patch.contact) s.contact = { ...s.contact, ...patch.contact };
  if (patch.extra) s.extra = { ...s.extra, ...patch.extra };
  return { slots: s, notes };
}

export const toRef = (c: Candidate): RestaurantRef => ({
  id: c.id,
  name: c.name,
  district: c.district,
  address: c.address,
  phone: c.phone,
  option: c.option,
});

// ============================================================================ 找店
async function withOptions(search: SearchProvider, places: Place[]): Promise<Candidate[]> {
  const top = places.slice(0, 8);
  const opts = await Promise.all(top.map((p) => search.findBookingOption(p)));
  const out: Candidate[] = [];
  top.forEach((p, i) => {
    const option = opts[i];
    if (option) out.push({ ...p, option });
  });
  return out;
}

type Ask = Pick<Step, 'pending' | 'message'> & Partial<Pick<Step, 'candidates'>>;

const chooseAsk = (cands: Candidate[], message: string): Ask => ({
  pending: {
    kind: 'choose_restaurant',
    options: cands.map(({ option, ...c }) => ({ ...c, booking: option.channel })),
  },
  candidates: cands,
  message,
});

/** 還沒選定餐廳時:依店名或地區 / 料理找。回傳 ask 代表要問使用者;回傳 null 代表已選定可以往下走 */
async function resolveRestaurant(s: Slots, ports: DialogPorts): Promise<Ask | null> {
  let prefix = '';

  if (s.restaurant_query) {
    const q = s.restaurant_query;
    const places = await ports.search.findPlaces({ name: q });
    if (places.length > 0) {
      const bookable = await withOptions(ports.search, places);
      if (bookable.length === 1 && places.length === 1) {
        s.restaurant = toRef(bookable[0]!);
        return null;
      }
      if (bookable.length > 0) {
        return chooseAsk(bookable.slice(0, MAX_CANDIDATES), `找到幾家符合「${q}」、可以線上訂位的店,想訂哪一家?`);
      }
      // 找得到店,但搜尋不到訂位連結:誠實告知,並提供同區同類型、有訂位連結的替代選擇
      const p = places[0]!;
      const tel = p.phone ? `電話 ${p.phone}` : '請直接聯絡店家';
      const alts = (await withOptions(ports.search, await ports.search.findPlaces({ district: p.district, cuisine: p.cuisine }))).filter(
        (c) => c.id !== p.id,
      );
      delete s.restaurant_query;
      const base = `找到「${p.name}」,但搜尋不到它的線上訂位連結,我沒辦法幫你代訂(${tel})。`;
      return alts.length > 0
        ? chooseAsk(alts.slice(0, MAX_CANDIDATES), `${base}同一區也有這些可以線上訂位的${p.cuisine ?? ''}店,要改訂哪一家嗎?`)
        : { pending: { kind: 'provide_request' }, message: `${base}要不要換一家,或告訴我地區和料理類型,我幫你找?` };
    }
    delete s.restaurant_query;
    if (!s.area && !s.cuisine) {
      return { pending: { kind: 'provide_request' }, message: `找不到「${q}」。可以再給我完整一點的店名,或告訴我地區和想吃的料理類型嗎?` };
    }
    prefix = `找不到「${q}」,改依你說的條件幫你找。`;
  }

  if (s.area || s.cuisine) {
    const label = `${s.area ?? ''}${s.cuisine ?? ''}`;
    const cands = await withOptions(ports.search, await ports.search.findPlaces({ district: s.area, cuisine: s.cuisine }));
    if (cands.length === 0) {
      return {
        pending: { kind: 'provide_request' },
        message: `${prefix}${label}附近找不到可以線上訂位的店。要不要換個地區或料理類型?`,
      };
    }
    return chooseAsk(cands.slice(0, MAX_CANDIDATES), `${prefix}幫你找到這幾家${label}、可以線上訂位的店,想訂哪一家?`);
  }

  return { pending: { kind: 'provide_request' }, message: '想訂哪一家餐廳?告訴我店名,或是地區和想吃的料理類型,我來幫你找。' };
}

// ============================================================================ 欄位
const CONTACT_FIELDS: Record<'name' | 'phone' | 'email', InfoField> = {
  name: { key: 'contact.name', label: '訂位姓名', type: 'text' },
  phone: { key: 'contact.phone', label: '台灣手機（09xxxxxxxx）', type: 'tel' },
  email: { key: 'contact.email', label: '電子郵件', type: 'email' },
};

export const fmtDay = (date: string) => `${date}(週${weekdayOf(date)})`;

// ============================================================================ 主流程
export async function advance(
  slots: Slots,
  notes: string[],
  ports: DialogPorts,
): Promise<Step> {
  const s: Slots = structuredClone(slots);
  const lead = notes.join('');
  const ask = (a: Ask): Step => ({
    slots: s,
    status: 'collecting',
    pending: a.pending,
    candidates: a.candidates ?? null,
    plan: null,
    message: `${lead}${a.message}`,
  });

  // 1) 餐廳
  if (!s.restaurant) {
    const a = await resolveRestaurant(s, ports);
    if (a) return ask(a);
  }
  const r = s.restaurant!;

  // 2) 日期 / 時間 / 人數
  // 依序一次問一項:人數 → 日期 → 時段(時段要等人數與日期都有,才查得到店家可訂的時間,由 choose_time 讓使用者選)
  if (s.party_size === undefined) {
    return ask({ pending: { kind: 'provide_slots', fields: ['party_size'] }, message: `好的,訂「${r.name}」。請問幾位?` });
  }
  if (s.date === undefined) {
    return ask({ pending: { kind: 'provide_slots', fields: ['date'] }, message: `「${r.name}」${s.party_size} 位。請選擇用餐日期。` });
  }
  const date = s.date;
  const party = s.party_size;

  // 3) 問店家:這天能不能訂、有哪些時段、要填哪些資料
  const channel = ports.channels[r.option.channel];
  let insp;
  try {
    insp = await channel.inspect(r.option, date, party, AbortSignal.timeout(INSPECT_TIMEOUT_MS));
  } catch (e) {
    if (e instanceof ChannelError || (e as Error).name === 'TimeoutError') {
      throw new AppError(503, 'CHANNEL_UNAVAILABLE', `暫時無法查詢「${r.name}」的訂位狀況,請稍後再試。`);
    }
    throw e;
  }
  if (!insp.bookable) {
    delete s.date;
    return ask({
      pending: { kind: 'provide_slots', fields: ['date'] },
      message: `「${r.name}」${fmtDay(date)}${insp.reason ?? '沒有空位'}。要改哪一天?`,
    });
  }
  if (insp.maxParty && party > insp.maxParty) {
    delete s.party_size;
    return ask({
      pending: { kind: 'provide_slots', fields: ['party_size'] },
      message: `「${r.name}」單筆訂位最多 ${insp.maxParty} 位。要改成幾位?`,
    });
  }
  if (s.time === undefined) {
    return ask({
      pending: { kind: 'choose_time', options: insp.times },
      message: `「${r.name}」${fmtDay(date)} ${party} 位。請選擇用餐時段。`,
    });
  }
  const time = s.time;
  if (!insp.times.includes(time)) {
    delete s.time;
    return ask({
      pending: { kind: 'choose_time', options: insp.times },
      message: `「${r.name}」${fmtDay(date)}沒有 ${time} 的位子。可以訂的時段有:${insp.times.join('、')}。要選哪一個?`,
    });
  }

  // 4) 缺的聯絡資料 / 店家額外要求的欄位 —— 每家店要的不一樣,所以由店家表單決定
  const need = new Set<'name' | 'phone' | 'email'>(['name', ...insp.requiredContact]);
  const fields: InfoField[] = [];
  for (const k of ['name', 'phone', 'email'] as const) if (need.has(k) && !s.contact?.[k]) fields.push(CONTACT_FIELDS[k]);
  const extra: Record<string, string> = {};
  for (const f of insp.extraFields) {
    const v = s.extra?.[f.key];
    if (v && (!f.options || f.options.includes(v))) extra[f.key] = v;
    else fields.push({ key: `extra.${f.key}`, label: f.label, type: f.options ? 'select' : 'text', options: f.options });
  }
  s.extra = extra;
  if (fields.length > 0) {
    return ask({
      pending: { kind: 'provide_info', fields },
      message: `「${r.name}」訂位需要以下資料:${fields.map((f) => (f.options ? `${f.label}(${f.options.join('/')})` : f.label)).join('、')}。`,
    });
  }

  // 5) 出方案
  const labels = Object.fromEntries(insp.extraFields.map((f) => [f.key, f.label]));
  const contact: Plan['contact'] = { name: s.contact!.name! };
  if (s.contact?.phone) contact.phone = s.contact.phone;
  if (s.contact?.email) contact.email = s.contact.email;
  const plan: Plan = {
    restaurant: { id: r.id, name: r.name, address: r.address, phone: r.phone },
    target: r.option,
    date,
    time,
    party_size: party,
    contact,
    extra,
    ...(s.notes ? { notes: s.notes } : {}),
  };
  return {
    slots: s,
    status: 'awaiting_confirmation',
    pending: { kind: 'confirm_plan' },
    candidates: null,
    plan,
    message: `${lead}訂位方案已整理好,請確認:\n${describePlan(plan, labels)}\n確認後我才會幫你送出(訂位成功才會扣 ${ports.bookCost} 點)。方案 ${Math.round(
      ports.planTtlSec / 60,
    )} 分鐘內有效,過期要重新確認。`,
  };
}

export function describePlan(p: Plan, labels: Record<string, string> = {}): string {
  const c: Contact = p.contact;
  const contact = [c.name, c.phone, c.email].filter(Boolean).join(' / ');
  const extra = Object.entries(p.extra)
    .map(([k, v]) => `${labels[k] ?? k}:${v}`)
    .join('、');
  return [
    `餐廳:${p.restaurant.name}(${p.restaurant.address})`,
    `時間:${fmtDay(p.date)} ${p.time}`,
    `人數:${p.party_size} 位`,
    `聯絡:${contact}`,
    ...(extra ? [`其他:${extra}`] : []),
    ...(p.notes ? [`備註:${p.notes}`] : []),
  ].join('\n');
}
