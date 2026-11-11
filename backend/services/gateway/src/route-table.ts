export type Target = 'auth' | 'character' | 'chat' | 'billing' | 'booking';

export interface Route {
  /** 對外路徑前綴(不含 /v1) */
  prefix: string;
  target: Target;
  /** 不需要登入 */
  open?: boolean;
}

// 白名單路由:只有列在這裡的路徑才會被轉發。/internal/* 永遠不會被轉發到外部。
export const ROUTES: Route[] = [
  { prefix: '/auth/register', target: 'auth', open: true },
  { prefix: '/auth/login', target: 'auth', open: true },
  { prefix: '/auth/logout', target: 'auth' },
  { prefix: '/me', target: 'auth' },
  { prefix: '/characters', target: 'character' },
  { prefix: '/conversations', target: 'chat' },
  { prefix: '/points', target: 'billing' },
  { prefix: '/bookings', target: 'booking' },
];

export function findRoute(path: string): Route | undefined {
  return ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}

const SEND_RE = /^\/conversations\/[^/]+\/messages$/;

/** 送出聊天訊息(會呼叫模型、扣點),另外限流 */
export function isSendMessage(method: string, path: string): boolean {
  return method === 'POST' && SEND_RE.test(path);
}
