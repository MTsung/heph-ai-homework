import type { EventRow } from '../repositories/booking-event.repository';
import type { ChargeView } from '../repositories/charge.repository';
import { ACTIVE_DRAFT, isExpired, planHash, type BookingRow, type BookingStatus, type Plan, type Slots } from '../types';

/** 對外 API 的訂位回應格式。內部欄位(訂位連結、平台資訊、租約…)不外洩 */

export interface CostInfo {
  turnCost: number;
  bookCost: number;
}

/** history 的 keyset 分頁游標:(結束時間, id)。不透明字串,用戶端原樣帶回 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${new Date(at).toISOString()}|${id}`).toString('base64url');
}
export function decodeCursor(s: string): { at: string; id: string } | null {
  const [at, id] = Buffer.from(s, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return { at, id };
}

/** 使用者看得到的條件(去掉內部的訂位連結 / 平台資訊) */
function publicSlots(s: Slots) {
  const { restaurant, ...rest } = s;
  return {
    ...rest,
    restaurant: restaurant && { id: restaurant.id, name: restaurant.name, district: restaurant.district, address: restaurant.address, phone: restaurant.phone },
  };
}

function summarize(s: Slots, plan: Plan | null): string {
  const who = plan?.restaurant.name ?? s.restaurant?.name ?? s.restaurant_query ?? `${s.area ?? ''}${s.cuisine ?? ''}`;
  const when = [s.date, s.time].filter(Boolean).join(' ');
  return [who || '訂位需求', when, s.party_size ? `${s.party_size} 位` : ''].filter(Boolean).join(' · ');
}

export function toView(cost: CostInfo, row: BookingRow, extra: { events?: EventRow[]; charges?: unknown[] } = {}) {
  const expired = isExpired(row);
  const status: BookingStatus = expired ? 'expired' : row.status;
  const live = ACTIVE_DRAFT.includes(status);
  return {
    id: row.id,
    status,
    summary: summarize(row.slots, row.plan),
    pending: live ? row.pending : null,
    slots: publicSlots(row.slots),
    plan:
      row.plan && (live || status === 'expired')
        ? { ...row.plan, hash: row.plan_hash, version: row.plan_version, expires_at: row.expires_at, can_confirm: live && status === 'awaiting_confirmation' }
        : null,
    confirmed_plan: row.confirmed_plan ? { ...row.confirmed_plan, hash: planHash(row.confirmed_plan), confirmed_at: row.confirmed_at } : null,
    result: row.result,
    cost: { per_message: cost.turnCost, on_success: cost.bookCost },
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    ...(extra.events
      ? { events: extra.events.map((e) => ({ id: Number(e.id), type: e.type, text: e.text, data: e.data, at: e.created_at })) }
      : {}),
    ...(extra.charges ? { charges: extra.charges as ChargeView[] } : {}),
  };
}
export type BookingView = ReturnType<typeof toView>;

/** 列表的一筆:直接顯示「哪家、哪天幾點、幾位」,不必逐筆再查詳情 */
export function toListItem(cost: CostInfo, r: BookingRow) {
  const v = toView(cost, r);
  const plan = r.confirmed_plan ?? r.plan;
  return {
    id: v.id,
    status: v.status,
    summary: v.summary,
    pending_kind: v.pending?.kind ?? null,
    expires_at: v.status === 'awaiting_confirmation' ? r.expires_at : null,
    restaurant: plan ? { name: plan.restaurant.name, phone: plan.restaurant.phone ?? null, address: plan.restaurant.address } : null,
    date: plan?.date ?? r.slots.date ?? null,
    time: plan?.time ?? r.slots.time ?? null,
    party_size: plan?.party_size ?? r.slots.party_size ?? null,
    result: v.result,
    updated_at: v.updated_at,
    finished_at: v.finished_at,
  };
}
