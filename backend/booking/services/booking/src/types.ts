import { createHash } from 'node:crypto';

// ============================================================================ 狀態
/**
 * 一筆訂位需求的生命週期:
 *
 *   collecting ──(資料齊全)──▶ awaiting_confirmation ──(使用者確認,且未過期)──▶ confirmed ──▶ executing ──┬▶ succeeded
 *       │                              │                                                                    ├▶ failed    (店家拒絕 / 確定沒送出)
 *       │                              ├──▶ expired    (確認期限已過)                                       └▶ unknown   (送出了但不知道結果)
 *       └──────────────────────────────┴──▶ cancelled  (使用者取消)
 *
 * awaiting_confirmation 時如果使用者又改了條件,會產生新方案(版本 +1、雜湊值改變、期限重算),舊方案作廢。
 */
export type BookingStatus =
  | 'collecting'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired';

export const ACTIVE_DRAFT: BookingStatus[] = ['collecting', 'awaiting_confirmation'];

/** 等待確認但已過期(背景任務還沒把狀態落地前,讀取時就要當作過期) */
export const isExpired = (r: { status: BookingStatus; expires_at: Date | null }) =>
  r.status === 'awaiting_confirmation' && !!r.expires_at && new Date(r.expires_at).getTime() <= Date.now();
export const IN_PROGRESS: BookingStatus[] = ['confirmed', 'executing'];
export const TERMINAL: BookingStatus[] = ['succeeded', 'failed', 'unknown', 'cancelled', 'expired'];

// ============================================================================ 訂位管道
/** 搜尋後得知這家店「怎麼訂」。這是內部資訊,存在需求裡,方案確認時會連同目標一起凍結 */
export type BookingOption =
  /** 由 browser-agent 操作真實訂位網站。目前只支援已授權的享樂地圖(JoyMap)測試店家 */
  | { channel: 'browser_agent'; site: 'joymap'; url: string; restaurantId: string };

// ============================================================================ 使用者提供的條件
export interface Contact {
  name?: string;
  phone?: string;
  email?: string;
}

export interface RestaurantRef {
  id: string;
  name: string;
  district?: string;
  address: string;
  phone?: string;
  option: BookingOption;
}

/** 對話累積出來的條件。NLU 只負責往這裡「補資料」,接下來要問什麼、能不能出方案,由 dialog.ts 的規則決定 */
export interface Slots {
  restaurant_query?: string;
  area?: string;
  cuisine?: string;
  restaurant?: RestaurantRef;
  date?: string; // YYYY-MM-DD(台北時間)
  time?: string; // HH:MM(24 小時制)
  party_size?: number;
  contact?: Contact;
  /** 店家表單的額外必填欄位(例如座位偏好) */
  extra?: Record<string, string>;
  notes?: string;
}

/** 這一輪使用者新給的資訊(NLU 或結構化輸入的結果) */
export type Patch = Partial<Pick<Slots, 'restaurant_query' | 'area' | 'cuisine' | 'date' | 'time' | 'party_size' | 'notes'>> & {
  contact?: Contact;
  extra?: Record<string, string>;
};

export interface Candidate {
  id: string;
  name: string;
  district: string;
  cuisine?: string;
  address: string;
  phone?: string;
  rating?: number;
  option: BookingOption;
}

// ============================================================================ 待回答的問題
export interface InfoField {
  /** contact.name / contact.phone / contact.email / extra.<欄位名> */
  key: string;
  label: string;
  type: 'text' | 'tel' | 'email' | 'select';
  options?: string[];
}

export type Pending =
  | { kind: 'provide_request' }
  | { kind: 'choose_restaurant'; options: Array<Omit<Candidate, 'option'> & { booking: BookingOption['channel'] }> }
  | { kind: 'provide_slots'; fields: Array<'date' | 'time' | 'party_size'> }
  | { kind: 'choose_time'; options: string[] }
  | { kind: 'provide_info'; fields: InfoField[] }
  | { kind: 'confirm_plan' };

// ============================================================================ 方案
/**
 * 使用者確認的就是這份內容,而且只有這份內容會被送出。
 * `target` 也在裡面:連「送到哪一個網址 / 平台」都被確認凍結,執行時不會再重新搜尋或重新決定。
 */
export interface Plan {
  restaurant: { id: string; name: string; address: string; phone?: string };
  target: BookingOption;
  date: string;
  time: string;
  party_size: number;
  contact: Contact & { name: string };
  extra: Record<string, string>;
  notes?: string;
}

/** key 排序後的 JSON,讓同樣內容永遠得到同樣的字串(雜湊才穩定) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const planHash = (p: Plan): string => createHash('sha256').update(canonicalJson(p)).digest('hex').slice(0, 24);

// ============================================================================ 結果
export interface BrowserTrace {
  enabled: boolean;
  run_id?: string;
  manifest?: string;
  screenshot_count?: number;
  step_count?: number;
  started_at?: string;
  finished_at?: string;
}

export type BookingResult =
  | { ok: true; confirmation_no: string; trace?: BrowserTrace }
  | { ok: false; code: string; message: string; stage?: string; trace?: BrowserTrace };

/** bookings 表的一列(pg 把 jsonb 解析成物件、timestamptz 解析成 Date) */
export interface BookingRow {
  id: string;
  user_id: string;
  status: BookingStatus;
  slots: Slots;
  pending: Pending | null;
  candidates: Candidate[] | null;
  plan: Plan | null;
  plan_hash: string | null;
  plan_version: number;
  expires_at: Date | null;
  confirmed_plan: Plan | null;
  confirmed_at: Date | null;
  exec_phase: 'pre_submit' | 'submitting' | null;
  charge_ref: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_until: Date | null;
  result: BookingResult | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

// ============================================================================ 訂位管道介面
export interface Inspection {
  /** false = 這天完全不能訂(公休、無空位),reason 給使用者看 */
  bookable: boolean;
  reason?: string;
  times: string[];
  maxParty?: number;
  /** 必填的聯絡資料 */
  requiredContact: Array<'name' | 'phone' | 'email'>;
  /** 店家額外要求的必填欄位 */
  extraFields: Array<{ key: string; label: string; options?: string[] }>;
}

export type SubmitOutcome =
  | { kind: 'success'; confirmationNo: string; trace?: BrowserTrace }
  /** 確定沒有訂成(店家拒絕,或在送出前就失敗)。不會有訂位存在 */
  | { kind: 'rejected'; code: string; message: string; trace?: BrowserTrace }
  /** 請求可能已經送達對方,但不知道結果(逾時、連線中斷、看不懂的回應)。stage 是不含個資的瀏覽器執行階段 */
  | { kind: 'ambiguous'; reason: string; stage?: string; trace?: BrowserTrace };

export interface BookingChannel {
  readonly id: BookingOption['channel'];
  /** 同一個冪等鍵重送是否安全。browser_agent 沒有這種保證,所以結果不明時不能自動重送(會重複訂位) */
  readonly idempotent: boolean;
  /** 是否受「同時執行數」上限(例如瀏覽器操作很吃資源) */
  readonly limited: boolean;
  /** 唯讀:看這家店這天這個人數能不能訂、有哪些時段、要填什麼欄位。失敗時丟 ChannelError */
  inspect(option: BookingOption, date: string, party: number, signal: AbortSignal): Promise<Inspection>;
  /**
   * 送出訂位。`beforeSend` 會在「請求真正離開之前」被呼叫:
   * 呼叫端藉此先把「已進入送出階段」寫進資料庫(write-ahead),當機後才分得出「還沒送」與「可能已送」。
   */
  submit(plan: Plan, key: string, beforeSend: () => Promise<void>, signal: AbortSignal): Promise<SubmitOutcome>;
}

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}
