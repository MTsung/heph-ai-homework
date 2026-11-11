import { LlmError, sseData, type LlmProvider, type LlmRequest, type LlmResult, type ChatMsg } from './types';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * 思考(thinking)設定。**思考 token 以「輸出價」計費**,對簡短的聊天回覆是純成本,所以預設關閉。
   * 不同世代的模型參數不同,送錯會「被忽略(照樣思考、照樣收費)」或「被拒絕(400)」,所以不寫死:
   *   'budget:0'      Gemini 2.5 系列:thinkingBudget = 0(關閉)
   *   'level:minimal' Gemini 3 系列:thinkingLevel(minimal / low / medium / high;實際可用值依模型而定)
   *   'omit'          不送任何思考設定(用模型預設)
   */
  thinking: string;
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

// 這些 finishReason 代表「內容被安全/政策機制擋下」,不是故障
const BLOCKED_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

/**
 * 把我們的訊息轉成 Gemini 的格式:
 *  - system → systemInstruction
 *  - assistant → role "model"
 *  - 連續同角色的訊息合併(上一則 AI 回覆失敗時,歷史裡會出現連續兩則 user)
 *  - Gemini 的 contents 不能以 model 開頭 → 丟掉開頭的 model 訊息(通常是角色的開場白)
 */
export function toGeminiBody(
  messages: ChatMsg[],
  maxOutputTokens: number,
  thinking: string,
): Record<string, unknown> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns: Array<{ role: 'user' | 'model'; text: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n${m.content}`;
    else turns.push({ role, text: m.content });
  }
  while (turns.length > 0 && turns[0]!.role === 'model') turns.shift();

  const generationConfig: Record<string, unknown> = { maxOutputTokens };
  const [kind, value] = thinking.split(':');
  if (kind === 'budget') generationConfig.thinkingConfig = { thinkingBudget: Number(value) };
  else if (kind === 'level') generationConfig.thinkingConfig = { thinkingLevel: value };

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    generationConfig,
  };
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly defaultModel: string;

  constructor(private readonly o: GeminiOptions) {
    this.defaultModel = o.model;
  }

  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult, void> {
    const model = req.model || this.o.model;
    const url = `${this.o.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.o.apiKey, // 放標頭,不放 URL:金鑰不會出現在任何日誌或錯誤訊息的網址裡
        },
        body: JSON.stringify(toGeminiBody(req.messages, req.maxOutputTokens, this.o.thinking)),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw new LlmError(`無法連線到 Gemini:${(e as Error).message}`, 'LLM_UNREACHABLE', true);
    }

    if (!res.ok || !res.body) {
      // 錯誤本文是 { error: { code, message, status } },截短後帶進訊息(不含金鑰)
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
      const code = res.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_ERROR';
      throw new LlmError(`Gemini 回應 ${res.status} ${detail}`, code, true, true, res.status);
    }

    let text = '';
    let usage: LlmResult['usage'];
    let finishReason: string | undefined;
    let blockReason: string | undefined;

    for await (const data of sseData(res.body)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(data) as GeminiChunk;
      } catch {
        continue; // 無法解析的行直接略過
      }
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      const u = chunk.usageMetadata;
      if (u) {
        // usageMetadata 在每個 chunk 都會出現且是累積值,取最後一個。思考 token 以輸出價計費,算進輸出。
        usage = {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        };
      }
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      for (const part of cand?.content?.parts ?? []) {
        if (part.thought) continue; // 思考摘要不是要給使用者看的內容
        if (part.text) {
          text += part.text;
          yield part.text;
        }
      }
    }

    if (text.length === 0) {
      if (blockReason || (finishReason && BLOCKED_REASONS.has(finishReason))) {
        // 內容被擋不是故障:不換下一家(換一家去繞過安全過濾不妥),也不會因重試而成功
        throw new LlmError(`Gemini 拒絕回應(${blockReason ?? finishReason})`, 'LLM_BLOCKED', false, false);
      }
      throw new LlmError(`Gemini 沒有產生內容(${finishReason ?? 'unknown'})`, 'EMPTY_REPLY', true);
    }
    return { provider: this.name, model, usage, finishReason };
  }
}
