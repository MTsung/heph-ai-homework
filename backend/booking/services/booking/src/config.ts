import { env, envInt } from '@chat-app/shared/config';

export interface BookingConfig {
  port: number;
  /** 方案確認期限(秒):超過就不能再確認 */
  planTtlSec: number;
  /** 還沒出方案的草稿放多久沒動就作廢(秒) */
  draftTtlSec: number;
  /** 每次用 AI 理解需求 / 回覆一則訊息的點數 */
  turnCost: number;
  /** 訂位成功才扣的點數(失敗、結果不明都不扣) */
  bookCost: number;
  /** 同時間最多幾筆「需要操作網頁」的訂位在執行;超過就回「繁忙」 */
  maxConcurrent: number;
  busyRetryAfterSec: number;
  /** 單次送出的逾時。必須比店家正常處理時間久,又不能無限等 */
  submitTimeoutMs: number;
  /** 確認後多久內必須開始送出,否則放棄(例如一直排不到名額) */
  execDeadlineSec: number;
  /** 一位使用者同時最多幾筆進行中的草稿 */
  maxActivePerUser: number;
  /** 執行租約:程序當機後,最久多久會被別的 instance 接手 */
  leaseSec: number;
  /** llm = 有設定真實模型時用 LLM 理解需求;rules = 只用規則 */
  nluMode: string;
  nluTimeoutMs: number;
  drainWaitMs: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(): BookingConfig {
  return {
    port: envInt('PORT', 3005),
    planTtlSec: envInt('PLAN_TTL_SEC', 600),
    draftTtlSec: envInt('DRAFT_TTL_SEC', 86_400),
    turnCost: envInt('COST_TURN', 1),
    bookCost: envInt('COST_BOOK', 3),
    maxConcurrent: envInt('MAX_CONCURRENT_BOOKINGS', 3),
    busyRetryAfterSec: envInt('BUSY_RETRY_AFTER_SEC', 10),
    submitTimeoutMs: envInt('SUBMIT_TIMEOUT_MS', 15_000),
    execDeadlineSec: envInt('EXEC_DEADLINE_SEC', 300),
    maxActivePerUser: envInt('MAX_ACTIVE_PER_USER', 5),
    leaseSec: envInt('LEASE_SEC', 30),
    nluMode: env('BOOKING_NLU', 'llm'),
    nluTimeoutMs: envInt('NLU_TIMEOUT_MS', 8000),
    drainWaitMs: envInt('DRAIN_WAIT_MS', 20_000),
    shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 28_000),
  };
}
