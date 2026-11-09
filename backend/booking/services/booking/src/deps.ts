import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import client from 'prom-client';
import type { ServiceClient } from '../../../../shared/client';
import { envInt } from '../../../../shared/config';
import type { ConcurrencyLimiter } from './limiter';
import type { Logger } from '../../../../shared/log';
import type { Charges } from './charges';
import type { ChannelRegistry } from './channels';
import type { Nlu } from './nlu';
import type { SearchProvider } from './search';

export interface BookingConfig {
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
}

export function loadConfig(): BookingConfig {
  return {
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
  };
}

export function createMetrics(registry: client.Registry) {
  return {
    turns: new client.Counter({ name: 'booking_turns_total', help: '處理使用者訊息 / 操作的結果', labelNames: ['outcome'], registers: [registry] }),
    confirms: new client.Counter({ name: 'booking_confirms_total', help: '確認方案的結果', labelNames: ['outcome'], registers: [registry] }),
    executions: new client.Counter({ name: 'booking_executions_total', help: '送出訂位的最終結果', labelNames: ['channel', 'outcome'], registers: [registry] }),
    busy: new client.Counter({ name: 'booking_busy_total', help: '因同時執行數已滿而回覆「繁忙」的次數', registers: [registry] }),
    executing: new client.Gauge({ name: 'booking_executing', help: '本 instance 正在執行的訂位數', registers: [registry] }),
    nlu: new client.Counter({ name: 'booking_nlu_total', help: '需求理解使用的方式', labelNames: ['source'], registers: [registry] }),
    billingFailures: new client.Counter({
      name: 'booking_billing_failures_total',
      help: '結算 / 釋放點數呼叫失敗次數(交由 reaper 重試)',
      registers: [registry],
    }),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;

export interface Deps {
  pool: Pool;
  redis: Redis;
  billing: ServiceClient;
  /** browser-use agent。只允許已設定的訂位 URL。 */
  agent: ServiceClient;
  search: SearchProvider;
  channels: ChannelRegistry;
  nlu: Nlu;
  limiter: ConcurrencyLimiter;
  charges: Charges;
  log: Logger;
  metrics: Metrics;
  cfg: BookingConfig;
}

/**
 * 每次扣點「嘗試」都用全新的 ref(billing 的預扣以 ref 為冪等鍵,且結束後的 ref 不能再用)。
 * 訊息 / 確認本身的冪等不靠 ref,而是靠 client_msg_id 與狀態的條件式更新。
 */
export const newTurnRef = (bookingId: string) => `bk:${bookingId}:turn:${randomUUID()}`;
export const newExecRef = (bookingId: string) => `bk:${bookingId}:book:${randomUUID()}`;
