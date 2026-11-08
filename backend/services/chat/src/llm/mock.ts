import { envInt } from '../../../../shared/config';
import { LlmError, sleep, type ChatMsg, type LlmProvider, type LlmRequest, type LlmResult } from './types';

// ============================================================================
// Mock:沒有 API key 也能完整體驗聊天。回覆依角色風格與使用者輸入規則產生,逐字串流。
// 測試用控制碼(只有 mock 會理解):
//   [[fail]] → 回覆到一半丟出錯誤,用來驗證失敗時的點數釋放與重試
//   [[slow]] → 每個片段延遲 300ms,用來驗證斷線續傳
// ============================================================================
const persona: Record<string, { open: string[]; close: string[]; hello: string; tone: string }> = {
  xi: {
    open: ['嗯嗯,', '我懂,', '謝謝你願意跟我說,'],
    close: ['我在這裡聽你說。', '慢慢來,不急。', '你的感受很重要。'],
    hello: '嗨,見到你真好。今天心情怎麼樣?',
    tone: '溫柔',
  },
  che: {
    open: ['哈哈,', '欸,', '笑死,'],
    close: ['你說對吧?', '來,繼續爆料。', '我先幫你記一筆。'],
    hello: '欸來啦!今天有什麼新鮮事?',
    tone: '幽默',
  },
  ella: {
    open: ['好問題。', '我們一步一步來看,', '先釐清一件事,'],
    close: ['這樣說得通嗎?', '要不要我舉個例子?', '你可以試著用自己的話再說一次。'],
    hello: '哈囉,今天想學點什麼?',
    tone: '條理',
  },
  noct: {
    open: ['……', '夜很深了,', '或許吧,'],
    close: ['有些答案,要等天亮才看得清。', '你怎麼看呢?', '慢慢想,不用急著下結論。'],
    hello: '晚安。這個時間還醒著,心裡一定有些事。',
    tone: '沉靜',
  },
};

const NEGATIVE = /(累|煩|難過|傷心|焦慮|壓力|生氣|崩潰|孤單|寂寞|失眠|害怕|沮喪|委屈)/;
const POSITIVE = /(開心|高興|太好了|成功|通過|讚|棒|幸福|興奮|升職|加薪)/;
const GREETING = /^(嗨|哈囉|你好|您好|hi|hello|hey|早安|午安|晚安|在嗎)/i;
const QUESTION = /([?？]|嗎|什麼|為什麼|怎麼|如何|是不是|有沒有)/;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function snippet(s: string, max = 14): string {
  const t = s.replace(/\s+/g, ' ').replace(/\[\[.*?\]\]/g, '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function mockReply(slug: string, history: ChatMsg[], userText: string): string {
  const p = persona[slug] ?? persona.xi!;
  const h = hash(userText);
  const open = p.open[h % p.open.length]!;
  const close = p.close[(h >> 3) % p.close.length]!;
  const quote = snippet(userText);

  let body: string;
  if (GREETING.test(userText.trim())) {
    body = p.hello;
    return body;
  } else if (NEGATIVE.test(userText)) {
    const kw = NEGATIVE.exec(userText)![1]!;
    body = `聽起來你最近有點${kw}。發生什麼事了嗎?可以從讓你最在意的那一件開始說。`;
  } else if (POSITIVE.test(userText)) {
    const kw = POSITIVE.exec(userText)![1]!;
    body = `哇,${kw}!真替你高興。是什麼讓你有這樣的感覺?`;
  } else if (QUESTION.test(userText)) {
    body = `關於「${quote}」,我的想法是:先看你真正想要的是什麼,再決定下一步會比較踏實。你自己傾向哪一邊?`;
  } else {
    body = `你說「${quote}」,我想多了解一些細節。當時是什麼情況?`;
  }

  // 「記得之前聊過的事」:引用較早的一則使用者訊息(取決於輸入內容,結果可重現)
  const earlier = history.filter((m) => m.role === 'user').slice(0, -1);
  let memory = '';
  if (earlier.length >= 2 && h % 3 === 0) {
    const prev = earlier[(h >> 5) % earlier.length]!;
    memory = `對了,你之前提到「${snippet(prev.content, 12)}」,後來怎麼樣了?`;
  }
  return `${open}${body}${memory}${close}`;
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly defaultModel = 'mock-1';
  private readonly delayMs = envInt('MOCK_TOKEN_DELAY_MS', 25);

  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult, void> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const history = req.messages.filter((m) => m.role !== 'system');
    const text = mockReply(req.persona.slug, history, lastUser);
    const slow = lastUser.includes('[[slow]]');
    const fail = lastUser.includes('[[fail]]');
    const chars = Array.from(text); // 以 code point 切,避免把表情符號切成亂碼

    let i = 0;
    let emitted = 0;
    while (i < chars.length) {
      const size = 1 + ((i * 7 + chars.length) % 3); // 1–3 個字一包,模擬 token
      const piece = chars.slice(i, i + size).join('');
      i += size;
      await sleep(slow ? 300 : this.delayMs, req.signal);
      yield piece;
      emitted += size;
      if (fail && emitted >= Math.min(10, chars.length - 1)) {
        throw new LlmError('mock: 模擬的模型錯誤', 'LLM_ERROR', true);
      }
    }
    return { provider: this.name, model: this.defaultModel, finishReason: 'STOP' };
  }
}
