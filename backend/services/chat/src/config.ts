import { envInt } from '@chat-app/shared/config';

export interface ChatConfig {
  port: number;
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
  /** 關閉時等進行中回覆自然結束的時間;逾時才強制中止 */
  drainWaitMs: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(): ChatConfig {
  return {
    port: envInt('PORT', 3003),
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
    drainWaitMs: envInt('DRAIN_WAIT_MS', 20_000),
    shutdownTimeoutMs: envInt('SHUTDOWN_TIMEOUT_MS', 28_000),
  };
}
