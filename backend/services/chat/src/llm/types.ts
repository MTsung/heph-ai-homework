export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: ChatMsg[];
  /** 指定模型(例如角色的專屬模型)。只對「主要供應商」生效,見 FailoverProvider */
  model?: string;
  signal: AbortSignal;
  /** 輸出 token 上限。成本控制的第一道閘門 */
  maxOutputTokens: number;
  persona: { slug: string; name: string };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 一次生成結束後回報的資訊(AsyncGenerator 的 return 值) */
export interface LlmResult {
  provider: string;
  model: string;
  usage?: LlmUsage;
  /** 供應商回報的結束原因,例如 STOP / MAX_TOKENS */
  finishReason?: string;
}

export interface BreakerStatus {
  name: string;
  model: string;
  state: 'closed' | 'open' | 'half-open' | 'disabled';
  consecutiveFailures: number;
  /** 斷路器預計重新放行的時間(ms epoch);非 open 時為 0 */
  retryAt: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  stream(req: LlmRequest): AsyncGenerator<string, LlmResult, void>;
  /** 備援鏈才有:各供應商的健康狀態,供後台與診斷使用 */
  status?(): BreakerStatus[];
}

/**
 * 錯誤碼,以及它們對「換下一個供應商」的意義:
 *  - failover = true :這家壞了/不可用(逾時、5xx、429、連線失敗、金鑰錯誤…),換下一家可能成功
 *  - failover = false:不是故障(內容被安全過濾擋下),換一家也不該去繞過
 */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly failover: boolean = true,
    /** 供應商回傳的 HTTP 狀態碼(如果有) */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 設定錯誤類(金鑰無效、模型名稱不存在、參數被拒絕):要換下一家,但值得以較高等級記錄,因為重試不會自己好 */
export function isConfigError(e: LlmError): boolean {
  return e.status !== undefined && [400, 401, 403, 404].includes(e.status);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * 解析 SSE 回應,逐筆回傳 `data:` 的內容。
 * Gemini 與 OpenAI 相容 API 都是「每個 data: 行是一個完整 JSON」。
 * 行尾可能是 \n 或 \r\n(Google 用 \r\n),封包切分點任意,所以要自己累積成完整的行。
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const tail = buf.replace(/\r$/, '');
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
