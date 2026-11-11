import { envInt } from '@chat-app/shared/config';

export function loadConfig() {
  return {
    port: envInt('PORT', 3004),
    /** 新帳戶的註冊贈點 */
    signupBonus: envInt('SIGNUP_BONUS', 200),
    /** 餘額顯示用快取的 TTL(結算 / 釋放 / 入帳後會主動清掉) */
    balanceCacheTtlSec: envInt('BALANCE_CACHE_TTL_SEC', 30),
    /** 預扣沒帶 ttl_sec 時的期限;逾時由 sweeper 自動釋放 */
    defaultHoldTtlSec: envInt('HOLD_TTL_SEC', 600),
    /** 清理逾時預扣的間隔 */
    sweepIntervalMs: 30_000,
  };
}

export type BillingConfig = ReturnType<typeof loadConfig>;
