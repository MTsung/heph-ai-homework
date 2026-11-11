// 驗證「真實的」模型設定:依目前的環境變數建出供應商鏈,送一則很短的訊息,印出實際結果。
// 用來確認金鑰、模型名稱、思考參數是否被接受,以及實際的延遲與 token 用量(成本)。
//
//   docker compose exec chat bun scripts/llm-ping.ts            # 用 chat 容器目前的設定
//   docker compose exec chat bun scripts/llm-ping.ts 你好        # 自訂訊息
//
// 想單獨測某一家(略過備援),臨時指定:
//   docker compose exec -e LLM_PROVIDERS=gemini chat bun scripts/llm-ping.ts
export {};
import { createLlm } from '@chat-app/shared/llm';
import { createLogger } from '@chat-app/shared/log';

const text = process.argv.slice(2).join(' ') || '你好,請用一句話自我介紹。';
const log = createLogger('llm-ping');
const outcomes: string[] = [];

const llm = createLlm(
  {
    attempt: (p, o) => outcomes.push(`${p}:${o}`),
    failover: (f, t) => outcomes.push(`換手 ${f}→${t}`),
    breaker: () => undefined,
  },
  log,
);

console.log('供應商鏈:', llm.status().map((s) => `${s.name}(${s.model})`).join(' → '));
console.log('送出:', JSON.stringify(text), '\n');

const t0 = performance.now();
let first = 0;
let out = '';
const it = llm.stream({
  messages: [
    { role: 'system', content: '你是溫暖的朋友。請用繁體中文簡短回覆,1–2 句。' },
    { role: 'user', content: text },
  ],
  signal: AbortSignal.timeout(60_000),
  maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? 300),
  persona: { slug: 'xi', name: '小曦' },
});

try {
  for (;;) {
    const r = await it.next();
    if (r.done) {
      const ms = performance.now() - t0;
      console.log('回覆:', out);
      console.log('\n--- 結果 ---');
      console.log('供應商 / 模型 :', `${r.value.provider} / ${r.value.model}`);
      console.log('首字延遲      :', `${Math.round(first)} ms`);
      console.log('總耗時        :', `${Math.round(ms)} ms`);
      console.log('結束原因      :', r.value.finishReason ?? '(未提供)');
      if (r.value.usage) {
        console.log('token 用量    :', `輸入 ${r.value.usage.inputTokens}、輸出 ${r.value.usage.outputTokens}`);
        console.log('              (輸出含思考 token;預期輸出 ≈ 回覆長度,若遠大於,代表思考沒有被關閉 → 檢查 GEMINI_THINKING)');
      } else {
        console.log('token 用量    : (供應商沒有回報)');
      }
      console.log('嘗試紀錄      :', outcomes.join(', '));
      process.exit(0);
    }
    if (!first) first = performance.now() - t0;
    out += r.value;
  }
} catch (e) {
  console.error('\n❌ 失敗:', (e as Error).message);
  console.error('嘗試紀錄:', outcomes.join(', ') || '(無)');
  console.error('\n常見原因:金鑰錯誤/未啟用(400/403)、模型名稱不存在(404)、GEMINI_THINKING 與模型世代不符(400)、配額用完(429)。');
  process.exit(1);
}
