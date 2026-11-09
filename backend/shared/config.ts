// 環境變數讀取。所有設定值都來自環境變數(.env / docker compose),程式碼裡不放祕密。

export function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (def !== undefined) return def;
  throw new Error(`缺少必要的環境變數:${name}`);
}

export function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`環境變數 ${name} 不是數字:${v}`);
  return n;
}

export function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-me';
const DEV_JWT_SECRET = 'dev-jwt-secret-change-me';

/** 服務之間互相呼叫時帶的共享密鑰。 */
export function internalToken(): string {
  const v = env('INTERNAL_TOKEN', DEV_INTERNAL_TOKEN);
  assertNotDefaultInProd('INTERNAL_TOKEN', v, DEV_INTERNAL_TOKEN);
  return v;
}

export function jwtSecret(): string {
  const v = env('JWT_SECRET', DEV_JWT_SECRET);
  assertNotDefaultInProd('JWT_SECRET', v, DEV_JWT_SECRET);
  return v;
}

function assertNotDefaultInProd(name: string, value: string, dev: string): void {
  if (process.env.NODE_ENV === 'production' && value === dev) {
    throw new Error(`${name} 在 production 環境不可使用預設值`);
  }
}

/** 各服務的內部位址(compose 內用 service 名稱,本機直跑用 localhost)。 */
export const urls = {
  auth: () => env('AUTH_URL', 'http://localhost:3001'),
  character: () => env('CHARACTER_URL', 'http://localhost:3002'),
  chat: () => env('CHAT_URL', 'http://localhost:3003'),
  billing: () => env('BILLING_URL', 'http://localhost:3004'),
  booking: () => env('BOOKING_URL', 'http://localhost:3005'),
  browserAgent: () => env('BROWSER_AGENT_URL', 'http://localhost:3010'),
};

/** Redis 事件 / 頻道 / key 的共用名稱,集中管理避免各服務拼錯。 */
export const channels = {
  sessionEvents: 'evt:session', // pub/sub:登入踢人、登出
  characterEvents: 'evt:character', // pub/sub:角色資料變更,通知各服務清本機快取
};

export const streams = {
  userEvents: 'events:user', // Redis Stream:user.deleted 等
};

export const keys = {
  session: (userId: string) => `sess:${userId}`,
};
