// 模擬器的餐廳資料。每家店刻意設計成不同的情境,用來驗證訂位服務的各種分支:
//   - 訂位管道不同:自家網頁表單 / 合作平台 API / 沒有線上訂位(只能打電話)
//   - 表單要求的聯絡資料不同:有的只要電話、有的還要 email、有的多一個必填的下拉選單
//   - 行為不同:正常 / 客滿 / 對方處理很慢 / 訂位成功了但回應送不回來 / 平台第一次回 503 但其實已收單
export type Channel = 'web_form' | 'platform_api' | 'none';
export type Behavior = 'normal' | 'full' | 'slow' | 'dropped' | 'flaky_platform';

export interface ExtraField {
  name: string;
  label: string;
  options: string[];
}

export interface Restaurant {
  id: string;
  name: string;
  city: string;
  district: string;
  cuisine: string;
  address: string;
  phone: string;
  rating: number;
  channel: Channel;
  /** 表單 / 平台要求的聯絡資料(姓名一律必填) */
  requirePhone: boolean;
  requireEmail: boolean;
  extra: ExtraField[];
  /** 每日可訂時段 */
  slots: string[];
  maxParty: number;
  /** 每個時段最多接受幾組 */
  capacity: number;
  /** 公休星期(0 = 週日) */
  closedWeekday?: number;
  behavior: Behavior;
}

const DINNER = ['17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'];
const LUNCH_DINNER = ['11:30', '12:00', '12:30', '13:00', ...DINNER];

const base = {
  city: '台北市',
  requirePhone: true,
  requireEmail: false,
  extra: [] as ExtraField[],
  slots: DINNER,
  maxParty: 8,
  capacity: 20,
  behavior: 'normal' as Behavior,
};

export const RESTAURANTS: Restaurant[] = [
  { ...base, id: 'r_sakura', name: '櫻花亭日本料理', district: '信義區', cuisine: '日式', address: '台北市信義區松仁路 28 號', phone: '02-2720-0001', rating: 4.6, channel: 'web_form' },
  {
    ...base,
    id: 'r_hinoki',
    name: '檜木割烹',
    district: '信義區',
    cuisine: '日式',
    address: '台北市信義區松高路 19 號',
    phone: '02-2720-0002',
    rating: 4.8,
    channel: 'web_form',
    requireEmail: true, // 這家要電話 + email
    closedWeekday: 1,
  },
  { ...base, id: 'r_kaisen', name: '海膳壽司', district: '信義區', cuisine: '日式', address: '台北市信義區忠孝東路五段 68 號', phone: '02-2720-0003', rating: 4.5, channel: 'platform_api', slots: LUNCH_DINNER },
  {
    ...base,
    id: 'r_izakaya',
    name: '夜行居酒屋',
    district: '信義區',
    cuisine: '日式',
    address: '台北市信義區松壽路 9 號',
    phone: '02-2720-0004',
    rating: 4.3,
    channel: 'web_form',
    extra: [{ name: 'seating', label: '座位偏好', options: ['吧台', '包廂'] }], // 多一個必填的下拉選單
  },
  { ...base, id: 'r_ding_xinyi', name: '鼎泰豐 信義店', district: '信義區', cuisine: '中式', address: '台北市信義區市府路 45 號', phone: '02-8101-0001', rating: 4.7, channel: 'web_form', slots: LUNCH_DINNER },
  { ...base, id: 'r_ding_101', name: '鼎泰豐 101 店', district: '信義區', cuisine: '中式', address: '台北市信義區松高路 12 號', phone: '02-8101-0002', rating: 4.6, channel: 'web_form', slots: LUNCH_DINNER },
  { ...base, id: 'r_yakiniku', name: '炭火燒肉屋', district: '大安區', cuisine: '燒肉', address: '台北市大安區忠孝東路四段 101 號', phone: '02-2777-0001', rating: 4.4, channel: 'web_form', behavior: 'dropped' },
  { ...base, id: 'r_full', name: '滿座食堂', district: '大安區', cuisine: '台菜', address: '台北市大安區永康街 7 號', phone: '02-2777-0002', rating: 4.2, channel: 'web_form', behavior: 'full' },
  { ...base, id: 'r_noodle', name: '老張牛肉麵', district: '中山區', cuisine: '台菜', address: '台北市中山區南京東路二段 3 號', phone: '02-2555-0001', rating: 4.5, channel: 'none' },
  { ...base, id: 'r_trattoria', name: '慢熱義式餐酒館', district: '大安區', cuisine: '義式', address: '台北市大安區仁愛路四段 55 號', phone: '02-2777-0003', rating: 4.4, channel: 'platform_api', behavior: 'flaky_platform' },
  { ...base, id: 'r_slowhouse', name: '慢工西餐廳', district: '中山區', cuisine: '西餐', address: '台北市中山區林森北路 88 號', phone: '02-2555-0002', rating: 4.1, channel: 'web_form', behavior: 'slow' },
];

export const byId = new Map(RESTAURANTS.map((r) => [r.id, r]));
