import type Redis from 'ioredis';
import type { Pool } from 'pg';
import client from 'prom-client';
import type { ServiceClient } from '../../../shared/client';
import { envInt } from '../../../shared/config';
import type { Logger } from '../../../shared/log';
import type { CharacterDirectory } from './characters';
import type { LlmHooks, LlmProvider, Semaphore } from '../../../shared/llm';
import type { RecentCache } from './recent';

export interface ChatConfig {
  // ---- 成本控制:輸入(每次請求都要重送的上下文)與輸出都要設上限 ----
  /** 組 LLM 上下文時最多帶幾則歷史訊息 / 總字元 / 單則歷史的字元上限 */
  contextMessages: number;
  contextChars: number;
  contextMsgMaxChars: number;
  /** 單次回覆的輸出 token 上限(傳給供應商);maxReplyChars 是伺服器端的最後一道字元保險 */
  maxOutputTokens: number;
  /** 對話層級的生成鎖:TTL 與續期間隔 */
  lockTtlMs: number;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  /** 串流片段批次寫入 Redis 的間隔(續傳/當機補救用) */
  flushMs: number;
  maxReplyChars: number;
  /** 單一 instance 同時進行中的生成數上限(超過就 503,讓上游改打別台或稍後重試) */
  maxActive: number;
  userMessageMaxChars: number;
  recentSize: number;
  recentTtlSec: number;
}

export function loadConfig(): ChatConfig {
  return {
    contextMessages: envInt('CONTEXT_MESSAGES', 12),
    contextChars: envInt('CONTEXT_CHARS', 2500),
    contextMsgMaxChars: envInt('CONTEXT_MSG_MAX_CHARS', 400),
    maxOutputTokens: envInt('LLM_MAX_OUTPUT_TOKENS', 300),
    lockTtlMs: envInt('GEN_LOCK_TTL_MS', 30_000),
    // 整體首字逾時必須大於「每個供應商的首字逾時(LLM_ATTEMPT_FIRST_TOKEN_MS,預設 8 秒)× 供應商數」,
    // 否則備援還沒輪到就被這個整體逾時砍掉。兩家備援 = 16 秒 + 餘裕。
    firstTokenTimeoutMs: envInt('FIRST_TOKEN_TIMEOUT_MS', 25_000),
    totalTimeoutMs: envInt('GEN_TIMEOUT_MS', 120_000),
    flushMs: envInt('STREAM_FLUSH_MS', 400),
    maxReplyChars: envInt('MAX_REPLY_CHARS', 600),
    maxActive: envInt('MAX_ACTIVE_GENERATIONS', 5000),
    userMessageMaxChars: envInt('USER_MESSAGE_MAX_CHARS', 500),
    recentSize: envInt('RECENT_CACHE_SIZE', 40),
    recentTtlSec: envInt('RECENT_CACHE_TTL_SEC', 86_400),
  };
}

export function createMetrics(registry: client.Registry) {
  return {
    active: new client.Gauge({
      name: 'chat_active_generations',
      help: '進行中的 AI 回覆串流數',
      registers: [registry],
    }),
    outcomes: new client.Counter({
      name: 'chat_generations_total',
      help: 'AI 回覆結果',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    ttft: new client.Histogram({
      name: 'chat_time_to_first_token_seconds',
      help: '從收到訊息到第一個字送出的時間',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
      registers: [registry],
    }),
    duration: new client.Histogram({
      name: 'chat_generation_duration_seconds',
      help: '一則 AI 回覆從開始到完成的時間',
      buckets: [0.5, 1, 2, 5, 10, 20, 60, 120],
      registers: [registry],
    }),
    // ---- LLM 供應商層 ----
    llmAttempts: new client.Counter({
      name: 'chat_llm_attempts_total',
      help: '對各供應商的嘗試結果(ok 或錯誤碼;chain/unavailable = 全部供應商都無法服務)',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    }),
    llmFailovers: new client.Counter({
      name: 'chat_llm_failovers_total',
      help: '備援換手次數',
      labelNames: ['from', 'to'],
      registers: [registry],
    }),
    llmBreakerOpen: new client.Gauge({
      name: 'chat_llm_breaker_open',
      help: '供應商斷路器是否開路(1 = 開路,冷卻期內直接跳過)',
      labelNames: ['provider'],
      registers: [registry],
    }),
    llmTokens: new client.Counter({
      name: 'chat_llm_tokens_total',
      help: '實際使用的 token 數(供應商回報;思考 token 算在 output)。成本的真實依據',
      labelNames: ['provider', 'kind'],
      registers: [registry],
    }),
    settleFailures: new client.Counter({
      name: 'chat_billing_settle_failures_total',
      help: '結算/釋放點數呼叫失敗次數(交由 reaper 重試)',
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

/** 把備援層的事件接到 Prometheus 指標 */
export function llmHooks(m: Metrics): LlmHooks {
  return {
    attempt: (provider, outcome) => m.llmAttempts.labels(provider, outcome).inc(),
    failover: (from, to) => m.llmFailovers.labels(from, to).inc(),
    breaker: (provider, open) => m.llmBreakerOpen.labels(provider).set(open ? 1 : 0),
  };
}

export interface Deps {
  pool: Pool;
  /** state Redis:生成鎖、串流續傳、事件 Stream */
  redis: Redis;
  recent: RecentCache;
  billing: ServiceClient;
  directory: CharacterDirectory;
  provider: LlmProvider;
  llmSem: Semaphore;
  log: Logger;
  metrics: Metrics;
  cfg: ChatConfig;
}

export const lockKey = (conversationId: string) => `lock:gen:${conversationId}`;
export const genStreamKey = (messageId: string) => `gen:${messageId}`;
