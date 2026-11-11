import { envInt } from '@chat-app/shared/config';

export function loadConfig() {
  return {
    port: envInt('PORT', 8080),
    /** 對外入口只轉發一般 API,body 上限比內部服務的 1MB 小 */
    maxBodyBytes: 262_144,
    /** 關閉時最多等進行中的轉發(含 SSE)多久 */
    drainMs: envInt('GATEWAY_DRAIN_MS', 22_000),
    /** 限流(每分鐘) */
    limits: {
      authPerIpPerMin: envInt('RL_AUTH_PER_IP_PER_MIN', 30),
      userPerMin: envInt('RL_USER_PER_MIN', 600),
      sendPerMin: envInt('RL_SEND_PER_USER_PER_MIN', 30),
      // 訂位的寫入操作(建立 / 回覆 / 確認…)每次都可能呼叫模型或搜尋,另外限流
      bookingPerMin: envInt('RL_BOOKING_PER_USER_PER_MIN', 30),
      eventsPerMin: 30,
    },
  };
}

export type GatewayConfig = ReturnType<typeof loadConfig>;
