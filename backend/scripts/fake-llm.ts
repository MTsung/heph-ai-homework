// 假的 LLM 伺服器:模仿 Gemini 與 OpenAI 相容 API 的串流格式,並能隨時切換成各種「壞掉」的模式。
// 用來在沒有真實金鑰的情況下演練/驗證備援機制,也用來檢查我們送出的請求內容(成本控制的參數)。
//
//   docker compose --profile tools up -d fake-llm
//   讓 chat 連它:GEMINI_BASE_URL=http://fake-llm:9000/gemini  GROQ_BASE_URL=http://fake-llm:9000/openai
//
// 控制介面(皆為 JSON):
//   POST /control  {"gemini":"ok|503|429|400|hang|hang_after_first|blocked|empty|midstream_fail","openai":"..."}
//   GET  /state    各端點的模式、被呼叫次數、最近一次收到的請求本文與標頭
//   POST /reset
export {};

type Mode = 'ok' | '503' | '429' | '400' | 'hang' | 'hang_after_first' | 'blocked' | 'empty' | 'midstream_fail';
const state = {
  modes: { gemini: 'ok' as Mode, openai: 'ok' as Mode },
  calls: { gemini: 0, openai: 0 },
  last: { gemini: null as unknown, openai: null as unknown },
};

const REPLY = ['嗯嗯,', '我聽到了。', '今天', '辛苦了,', '想聊聊嗎?'];
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sse(lines: string[], delayMs = 20, opts: { hangAfter?: number; failAfter?: number } = {}): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (opts.hangAfter !== undefined && i >= opts.hangAfter) return new Promise(() => undefined); // 永遠卡住
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        ctrl.error(new Error('connection reset'));
        return;
      }
      if (i >= lines.length) return ctrl.close();
      await sleep(delayMs);
      ctrl.enqueue(enc.encode(lines[i++]!));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

// ---- Gemini 格式:每行 data: {candidates, usageMetadata};用 \r\n(Google 實際就是這樣),結束靠 finishReason,沒有 [DONE]
const geminiChunk = (text: string, finish?: string, usage = true) =>
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }], role: 'model' }, ...(finish ? { finishReason: finish } : {}), index: 0 }],
    ...(usage ? { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: REPLY.join('').length, totalTokenCount: 200 } } : {}),
    modelVersion: 'fake-gemini',
  })}\r\n\r\n`;

function gemini(mode: Mode, body: any): Response {
  switch (mode) {
    case '503':
      return Response.json({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }, { status: 503 });
    case '429':
      return Response.json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    case '400':
      return Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, { status: 400 });
    case 'hang':
      return sse([], 0, { hangAfter: 0 });
    case 'blocked':
      // 提示本身被擋:沒有 candidates,只有 promptFeedback
      return sse([`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 50 } })}\r\n\r\n`]);
    case 'empty':
      return sse([geminiChunk('', 'STOP', true)]);
    case 'hang_after_first':
      return sse([geminiChunk(REPLY[0]!, undefined, false)], 20, { hangAfter: 1 });
    case 'midstream_fail':
      return sse(REPLY.map((t) => geminiChunk(t, undefined, false)), 20, { failAfter: 2 });
    default: {
      const lines = REPLY.map((t, i) => geminiChunk(t, i === REPLY.length - 1 ? 'STOP' : undefined, i === REPLY.length - 1));
      return sse(lines);
    }
  }
}

// ---- OpenAI 相容格式:data: {choices:[{delta:{content}}]},最後 usage chunk,再 data: [DONE]
const oaChunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
function openai(mode: Mode): Response {
  switch (mode) {
    case '503':
      return Response.json({ error: { message: 'Service unavailable' } }, { status: 503 });
    case '429':
      return Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 });
    case '400':
      return Response.json({ error: { message: 'Invalid API Key' } }, { status: 401 });
    case 'hang':
      return sse([], 0, { hangAfter: 0 });
    case 'empty':
      return sse([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']);
    case 'blocked':
      return sse([`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })}\n\n`, 'data: [DONE]\n\n']);
    case 'hang_after_first':
      return sse([oaChunk(REPLY[0]!)], 20, { hangAfter: 1 });
    case 'midstream_fail':
      return sse(REPLY.map(oaChunk), 20, { failAfter: 2 });
    default:
      return sse([
        ...REPLY.map(oaChunk),
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 110, completion_tokens: REPLY.join('').length } })}\n\n`,
        'data: [DONE]\n\n',
      ]);
  }
}

Bun.serve({
  port: Number(process.env.PORT ?? 9000),
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/control' && req.method === 'POST') {
      Object.assign(state.modes, await req.json());
      return Response.json(state.modes);
    }
    if (path === '/state') return Response.json(state);
    if (path === '/reset' && req.method === 'POST') {
      state.modes = { gemini: 'ok', openai: 'ok' };
      state.calls = { gemini: 0, openai: 0 };
      state.last = { gemini: null, openai: null };
      return Response.json({ ok: true });
    }
    if (path === '/reset-counts' && req.method === 'POST') {
      state.calls = { gemini: 0, openai: 0 };
      return Response.json({ ok: true });
    }
    if (path === '/healthz') return new Response('ok');

    // Gemini:POST /gemini/models/{model}:streamGenerateContent?alt=sse
    if (path.startsWith('/gemini/') && path.endsWith(':streamGenerateContent')) {
      state.calls.gemini++;
      const body = await req.json().catch(() => ({}));
      state.last.gemini = {
        path,
        query: url.search,
        apiKeyHeader: req.headers.get('x-goog-api-key'),
        keyInUrl: url.search.includes('key='),
        body,
      };
      return gemini(state.modes.gemini, body);
    }
    // OpenAI 相容:POST /openai/chat/completions
    if (path === '/openai/chat/completions') {
      state.calls.openai++;
      const body = await req.json().catch(() => ({}));
      state.last.openai = { path, auth: req.headers.get('authorization'), body };
      return openai(state.modes.openai);
    }
    return new Response('not found', { status: 404 });
  },
});
console.log('fake-llm listening on :' + (process.env.PORT ?? 9000));
