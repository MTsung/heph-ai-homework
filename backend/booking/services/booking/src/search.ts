import { env } from '../../../../shared/config';
import { AppError } from '../../../../shared/errors';
import type { BookingOption } from './types';

export interface Place {
  id: string;
  name: string;
  district: string;
  cuisine?: string;
  address: string;
  phone?: string;
  rating?: number;
}

/**
 * 「找店」與「這家店有沒有訂位連結」。對應 Google 上的兩個動作:
 *   findPlaces        在地圖 / 搜尋找餐廳(依店名、地區、料理)
 *   findBookingOption 搜尋「<店名> 訂位」,看有沒有可用的訂位連結或合作平台
 *
 * 目前只有模擬器實作。換成真的 Google 時只需要新增一個實作並在 createSearch 選用:
 *   - 找店:Google Places API (New) 的 Text Search(POST https://places.googleapis.com/v1/places:searchText)
 *   - 找訂位連結:一般網頁搜尋 API。注意 Google 的 Custom Search JSON API 已不收新客戶、2027/1/1 停用,
 *     不能當成長期方案,需另選網頁搜尋服務,再用網域(inline.app、EZTABLE 等)分類出訂位平台。
 */
export interface SearchProvider {
  findPlaces(q: { name?: string; district?: string; cuisine?: string }): Promise<Place[]>;
  findBookingOption(place: Place): Promise<BookingOption | null>;
}

export class SimSearch implements SearchProvider {
  private readonly base: string;

  constructor(base = env('SIM_URL', 'http://localhost:9100')) {
    this.base = base.replace(/\/$/, '');
  }

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
    try {
      const res = await fetch(`${this.base}${path}?${qs}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      throw new AppError(503, 'SEARCH_UNAVAILABLE', `搜尋服務暫時無法使用:${(e as Error).message}`);
    }
  }

  async findPlaces(q: { name?: string; district?: string; cuisine?: string }): Promise<Place[]> {
    const r = await this.get<{ items: Array<Place & { place_id: string }> }>('/search/places', {
      q: q.name,
      district: q.district,
      cuisine: q.cuisine,
    });
    return r.items.map(({ place_id, ...p }) => ({ ...p, id: place_id }));
  }

  async findBookingOption(place: Place): Promise<BookingOption | null> {
    const r = await this.get<{
      results: Array<{ kind: string; url?: string; platform?: string; platform_restaurant_id?: string }>;
    }>('/search/booking-link', { place_id: place.id, name: place.name });
    for (const x of r.results) {
      if (x.kind === 'web_form' && x.url) return { channel: 'web_form', url: x.url };
      if (x.kind === 'platform_api' && x.platform && x.platform_restaurant_id) {
        return { channel: 'platform_api', platform: x.platform, restaurantId: x.platform_restaurant_id };
      }
    }
    return null;
  }
}

/**
 * 真實訂位目標:享樂地圖(JoyMap)的測試店家「TEST01：Jump！Jump！」,由 browser-agent 操作。
 *
 * 只在使用者明確提到「Jump」或「TEST01」時回傳,避免把「想吃居酒屋」等泛查詢錯導到特定餐廳。
 * 其餘查詢維持既有的 booking-sim,讓目前的作業流程與端到端驗證不受影響。
 */
const JOYMAP_TEST: Place = {
  id: 'joymap-jump888',
  name: 'TEST01：Jump！Jump！',
  district: '淡水區',
  cuisine: '居酒屋',
  address: '新北市淡水區大忠街',
  phone: '027777777',
};
const JOYMAP_TRIGGER = /jump|test01/i;

export class BookingSearch implements SearchProvider {
  private readonly sim: SimSearch;
  private readonly bookingUrl: string;

  constructor() {
    this.sim = new SimSearch();
    this.bookingUrl = env('BROWSER_BOOKING_URL', 'https://www.joymap.tw/store/jump888');
  }

  async findPlaces(q: { name?: string; district?: string; cuisine?: string }): Promise<Place[]> {
    // 全形「Ｊｕｍｐ」也算:NFKC 把全形英數轉成半形
    if (q.name && JOYMAP_TRIGGER.test(q.name.normalize('NFKC'))) return [JOYMAP_TEST];
    return this.sim.findPlaces(q);
  }

  async findBookingOption(place: Place): Promise<BookingOption | null> {
    if (place.id === JOYMAP_TEST.id) {
      return { channel: 'browser_agent', site: 'joymap', url: this.bookingUrl, restaurantId: JOYMAP_TEST.id };
    }
    return this.sim.findBookingOption(place);
  }
}
