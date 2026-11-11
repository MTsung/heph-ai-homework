import { env } from '@chat-app/shared/config';
import type { BookingOption } from '../types';

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
 * 「找店」與「這家店有沒有訂位連結」。
 *
 * 目前只有享樂地圖(JoyMap)測試店家一種實作。之後要換成真的 Google 時,新增一個實作並在 index.ts 選用:
 *   - 找店:Google Places API (New) 的 Text Search(POST https://places.googleapis.com/v1/places:searchText)
 *   - 找訂位連結:一般網頁搜尋 API。注意 Google 的 Custom Search JSON API 已不收新客戶、2027/1/1 停用,
 *     不能當成長期方案,需另選網頁搜尋服務,再用網域(inline.app、EZTABLE 等)分類出訂位平台。
 */
export interface SearchProvider {
  findPlaces(q: { name?: string; district?: string; cuisine?: string }): Promise<Place[]>;
  findBookingOption(place: Place): Promise<BookingOption | null>;
}

/**
 * 真實訂位目標:享樂地圖(JoyMap)的測試店家「TEST01：Jump！Jump！」,由 browser-agent 操作。
 *
 * 只在使用者明確提到「Jump」或「TEST01」時回傳,避免把「想吃居酒屋」等泛查詢錯導到特定餐廳。
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
  private readonly bookingUrl: string;

  constructor() {
    this.bookingUrl = env('BROWSER_BOOKING_URL', 'https://www.joymap.tw/store/jump888');
  }

  async findPlaces(q: { name?: string; district?: string; cuisine?: string }): Promise<Place[]> {
    // 全形「Ｊｕｍｐ」也算:NFKC 把全形英數轉成半形
    if (q.name && JOYMAP_TRIGGER.test(q.name.normalize('NFKC'))) return [JOYMAP_TEST];
    return [];
  }

  async findBookingOption(place: Place): Promise<BookingOption | null> {
    if (place.id === JOYMAP_TEST.id) {
      return { channel: 'browser_agent', site: 'joymap', url: this.bookingUrl, restaurantId: JOYMAP_TEST.id };
    }
    return null;
  }
}
