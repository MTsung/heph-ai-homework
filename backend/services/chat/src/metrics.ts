import client from 'prom-client';
import type { LlmHooks } from '@chat-app/shared/llm';

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
