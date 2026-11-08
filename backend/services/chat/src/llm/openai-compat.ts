import { LlmError, sseData, type LlmProvider, type LlmRequest, type LlmResult } from './types';

export interface OpenAICompatOptions {
  /** 顯示/指標用名稱,例如 groq、openai、ollama */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 輸出上限的欄位名稱。OpenAI 新模型只接受 max_completion_tokens(送 max_tokens 會被拒絕),
   * 其他相容服務(Ollama…)多半只認 max_tokens。
   */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** 要求在串流最後回報 token 用量(stream_options.include_usage)。不支援的後端可能因未知欄位回 400,所以可關閉 */
  includeUsage: boolean;
}

interface Chunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** OpenAI 相容協定:OpenAI / Groq / Ollama(http://host:11434/v1)等 */
export class OpenAICompatProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;

  constructor(private readonly o: OpenAICompatOptions) {
    this.name = o.name;
    this.defaultModel = o.model;
  }

  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult, void> {
    const model = req.model || this.o.model;
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: true,
          [this.o.maxTokensParam]: req.maxOutputTokens,
          ...(this.o.includeUsage ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw new LlmError(`無法連線到 ${this.name}:${(e as Error).message}`, 'LLM_UNREACHABLE', true);
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
      const code = res.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_ERROR';
      throw new LlmError(`${this.name} 回應 ${res.status} ${detail}`, code, true, true, res.status);
    }

    let text = '';
    let usage: LlmResult['usage'];
    let finishReason: string | undefined;
    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        yield delta;
      }
    }

    if (text.length === 0) {
      if (finishReason === 'content_filter') {
        throw new LlmError(`${this.name} 拒絕回應(content_filter)`, 'LLM_BLOCKED', false, false);
      }
      throw new LlmError(`${this.name} 沒有產生內容(${finishReason ?? 'unknown'})`, 'EMPTY_REPLY', true);
    }
    return { provider: this.name, model, usage, finishReason };
  }
}
