import { env, envInt } from '../config';
import type { Logger } from '../log';
import { FailoverProvider, type LlmHooks } from './failover';
import { GeminiProvider } from './gemini';
import { MockProvider } from './mock';
import { OpenAICompatProvider } from './openai-compat';
import type { LlmProvider } from './types';

/**
 * 模型供應商工廠。
 *
 * 切換模型 = 改環境變數 `LLM_PROVIDERS`(有序清單,第一個是主要、其餘依序備援),不需要改程式:
 *     LLM_PROVIDERS=gemini,groq                      主要 Gemini,備援 Groq
 *     LLM_PROVIDERS=gemini:gemini-2.5-flash,gemini   指定模型(冒號後面;第一個冒號之前是供應商名稱)
 *     LLM_PROVIDERS=ollama:qwen2.5:7b                模型名稱本身可以含冒號
 *     LLM_PROVIDERS=mock                             預設。不需要任何金鑰
 *
 * 新增供應商 = 在 BUILDERS 加一行。
 * 每個供應商的設定用「大寫名稱」當前綴:GEMINI_API_KEY、GEMINI_MODEL、GEMINI_BASE_URL…
 */
interface Spec {
  name: string;
  /** 清單裡指定的模型(優先於 {NAME}_MODEL) */
  model?: string;
}

type Builder = (spec: Spec) => LlmProvider;

/** 讀 {PREFIX}_{KEY};缺少必要的金鑰就啟動失敗(寧可一開始就知道,也不要上線後才發現備援根本沒設定) */
function need(prefix: string, key: string): string {
  const name = `${prefix}_${key}`;
  const v = process.env[name];
  if (!v) throw new Error(`LLM_PROVIDERS 包含 ${prefix.toLowerCase()},但沒有設定環境變數 ${name}`);
  return v;
}

const compat =
  (name: string, defaults: { baseUrl: string; model: string; maxTokensParam: 'max_tokens' | 'max_completion_tokens'; includeUsage: boolean; keyRequired: boolean }): Builder =>
  (spec) => {
    const P = name.toUpperCase();
    return new OpenAICompatProvider({
      name,
      baseUrl: env(`${P}_BASE_URL`, defaults.baseUrl),
      apiKey: defaults.keyRequired ? need(P, 'API_KEY') : env(`${P}_API_KEY`, ''),
      model: spec.model ?? env(`${P}_MODEL`, defaults.model),
      maxTokensParam: defaults.maxTokensParam,
      includeUsage: defaults.includeUsage,
    });
  };

const BUILDERS: Record<string, Builder> = {
  mock: () => new MockProvider(),

  // 預設模型選「Flash-Lite」這一級:聊天回覆短、不需要深度推理,這一級的價格最低。
  // 模型更新很快(舊版會被下架或導向新版),所以名稱放環境變數,不寫死在程式裡。
  gemini: (spec) =>
    new GeminiProvider({
      apiKey: need('GEMINI', 'API_KEY'),
      model: spec.model ?? env('GEMINI_MODEL', 'gemini-2.5-flash-lite'),
      baseUrl: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
      thinking: env('GEMINI_THINKING', 'budget:0'),
    }),

  groq: compat('groq', {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    maxTokensParam: 'max_completion_tokens',
    includeUsage: true,
    keyRequired: true,
  }),
  openai: compat('openai', {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxTokensParam: 'max_completion_tokens',
    includeUsage: true,
    keyRequired: true,
  }),
  // 本機模型:不需要金鑰;容器內連到主機要用 host.docker.internal
  ollama: compat('ollama', {
    baseUrl: 'http://host.docker.internal:11434/v1',
    model: 'qwen2.5:7b',
    maxTokensParam: 'max_tokens',
    includeUsage: false,
    keyRequired: false,
  }),
};

/** 解析 "gemini,groq" / "gemini:模型,groq" */
export function parseChain(raw: string): Spec[] {
  const specs = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return i < 0 ? { name: s.toLowerCase() } : { name: s.slice(0, i).toLowerCase(), model: s.slice(i + 1) };
    });
  if (specs.length === 0) throw new Error('LLM_PROVIDERS 不可為空');
  for (const s of specs) {
    if (!BUILDERS[s.name]) {
      throw new Error(`不支援的供應商 "${s.name}"。可用:${Object.keys(BUILDERS).join(' / ')}`);
    }
  }
  return specs;
}

export function createLlm(hooks: LlmHooks, log: Logger): FailoverProvider {
  const specs = parseChain(env('LLM_PROVIDERS', 'mock'));
  const providers = specs.map((s) => BUILDERS[s.name]!(s));
  return new FailoverProvider(
    providers,
    {
      firstTokenMs: envInt('LLM_ATTEMPT_FIRST_TOKEN_MS', 8000),
      stallMs: envInt('LLM_STALL_MS', 15_000),
      breakerFailures: envInt('LLM_BREAKER_FAILURES', 3),
      breakerCooldownMs: envInt('LLM_BREAKER_COOLDOWN_MS', 20_000),
    },
    hooks,
    log,
  );
}

export const supportedProviders = (): string[] => Object.keys(BUILDERS);
