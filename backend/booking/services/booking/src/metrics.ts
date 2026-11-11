import client from 'prom-client';
import type { LlmHooks } from '@chat-app/shared/llm';

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
    llmAttempts: new client.Counter({
      name: 'booking_llm_attempts_total',
      help: '對各模型供應商的嘗試結果',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

/** 需求理解只記錄每次嘗試的結果 */
export function llmHooks(m: Metrics): LlmHooks {
  return { attempt: (p, o) => m.llmAttempts.labels(p, o).inc(), failover: () => undefined, breaker: () => undefined };
}
