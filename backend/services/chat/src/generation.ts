import { extendLock, releaseLock } from '../../../shared/redis';
import { markFailed, releaseHold, settleHold } from './billing';
import type { CharacterInfo } from './characters';
import { genStreamKey, lockKey, type Deps } from './deps';
import { LlmError, type ChatMsg, type LlmResult } from './llm';
import type { MessageDto } from './recent';

export type GenEvent =
  | { type: 'delta'; n: number; text: string }
  | { type: 'done'; message: MessageDto; balance: number | null }
  | { type: 'error'; code: string; message: string; retryable: boolean; state: MessageDto };

export interface GenParams {
  assistantId: string;
  conversationId: string;
  userId: string;
  seq: number;
  holdRef: string;
  character: CharacterInfo;
  messages: ChatMsg[];
  createdAt: string;
  clientMsgId?: string;
}

const USER_MESSAGES: Record<string, string> = {
  LLM_ERROR: '模型暫時無法回應,請稍後再試',
  LLM_RATE_LIMITED: '目前使用的人太多,請稍後再試',
  LLM_UNREACHABLE: '模型服務連線失敗,請稍後再試',
  SERVER_BUSY: '系統忙碌中,請稍後再試',
  FIRST_TOKEN_TIMEOUT: '模型沒有回應,請重試',
  GENERATION_TIMEOUT: '回覆逾時,請重試',
  EMPTY_REPLY: '模型沒有產生內容,請重試',
  SERVER_RESTARTING: '服務更新中,請重試',
  USER_DELETED: '帳號已刪除',
  // 備援鏈裡的供應商全都無法服務:對使用者統一說「目前有問題」,不暴露內部細節。不扣點。
  LLM_UNAVAILABLE: '目前系統有問題,請稍後再試',
  // 內容被模型的安全機制擋下。不是故障,所以不換供應商也不重試同樣內容
  LLM_BLOCKED: '這則訊息我沒辦法回應,換個說法試試吧',
  GENERATION_INTERRUPTED: '回覆中斷,請重試',
};

function classify(e: unknown, signal: AbortSignal): { code: string; message: string; retryable: boolean } {
  const reason = signal.aborted ? signal.reason : e;
  if (reason instanceof LlmError) {
    return { code: reason.code, message: USER_MESSAGES[reason.code] ?? '回覆失敗,請重試', retryable: reason.retryable };
  }
  if (e instanceof LlmError) {
    return { code: e.code, message: USER_MESSAGES[e.code] ?? '回覆失敗,請重試', retryable: e.retryable };
  }
  return { code: 'LLM_ERROR', message: USER_MESSAGES.LLM_ERROR!, retryable: true };
}

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/**
 * 一則 AI 回覆的生成過程。
 *
 * 核心設計:生成與 HTTP 連線脫鉤。
 *   - 生成在背景持續跑;SSE 連線只是「訂閱者」,斷線只會取消訂閱,不會中止生成。
 *     使用者關掉 App 再回來,回覆已經完整存好、點數也已結算。
 *   - 串流片段每 flushMs 批次寫入 Redis Stream:換一台 instance 也能續傳;
 *     instance 當掉時,reaper 能從 Redis 撈回已產生的部分文字。
 *   - 每個 token 只在記憶體內廣播給訂閱者,不寫 DB、也不逐字打 Redis。DB 只在開始與結束各寫一次。
 */
export class Generation {
  text = '';
  n = 0;
  terminal?: GenEvent;

  private listeners = new Set<(e: GenEvent) => void>();
  private readonly abort = new AbortController();
  private pending = '';
  private flushChain: Promise<void> = Promise.resolve();
  private readonly startedAt = performance.now();
  /** 供應商回報的實際結果(供應商、模型、token 用量) */
  private result?: LlmResult;

  constructor(
    private readonly d: Deps,
    readonly p: GenParams,
  ) {}

  /** 訂閱:回傳目前累積的文字(snapshot)與取消函式。已結束的生成會立刻重播結束事件。 */
  subscribe(fn: (e: GenEvent) => void): { text: string; n: number; unsubscribe: () => void } {
    const snapshot = { text: this.text, n: this.n };
    if (this.terminal) {
      queueMicrotask(() => fn(this.terminal!));
      return { ...snapshot, unsubscribe: () => undefined };
    }
    this.listeners.add(fn);
    return { ...snapshot, unsubscribe: () => this.listeners.delete(fn) };
  }

  cancel(reason: LlmError): void {
    if (!this.abort.signal.aborted) this.abort.abort(reason);
  }

  private emit(e: GenEvent): void {
    if (e.type !== 'delta') this.terminal = e;
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.d.log.warn({ err: (err as Error).message }, 'generation listener failed');
      }
    }
    if (e.type !== 'delta') this.listeners.clear();
  }

  async run(): Promise<void> {
    const { d, p } = this;
    const renew = setInterval(() => {
      extendLock(d.redis, lockKey(p.conversationId), p.assistantId, d.cfg.lockTtlMs).catch(() => undefined);
    }, Math.max(1000, d.cfg.lockTtlMs / 3));
    const flusher = setInterval(() => this.scheduleFlush(), d.cfg.flushMs);
    const totalTimer = setTimeout(
      () => this.cancel(new LlmError('回覆逾時', 'GENERATION_TIMEOUT', true)),
      d.cfg.totalTimeoutMs,
    );
    const firstTokenTimer = setTimeout(
      () => this.cancel(new LlmError('模型沒有回應', 'FIRST_TOKEN_TIMEOUT', true)),
      d.cfg.firstTokenTimeoutMs,
    );
    let releaseSlot: (() => void) | undefined;
    let outcome = 'completed';

    try {
      releaseSlot = await d.llmSem.acquire(5000);
      // 手動迭代(而不是 for await):要拿到 generator 的 return 值(實際用了哪個供應商、多少 token)。
      // 代價是提早結束時必須自己呼叫 return() 關閉供應商的串流 —— 否則模型會繼續產生、輸出 token 照樣計費。
      const it = d.provider.stream({
        messages: p.messages,
        model: p.character.model ?? undefined,
        signal: this.abort.signal,
        maxOutputTokens: d.cfg.maxOutputTokens,
        persona: { slug: p.character.slug, name: p.character.name },
      });
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) {
            this.result = r.value;
            break;
          }
          if (this.n === 0) {
            clearTimeout(firstTokenTimer);
            d.metrics.ttft.observe((performance.now() - this.startedAt) / 1000);
          }
          let piece = r.value;
          const room = d.cfg.maxReplyChars - this.text.length;
          const truncated = piece.length >= room;
          if (truncated) piece = piece.slice(0, Math.max(0, room));
          if (piece) {
            this.text += piece;
            this.pending += piece;
            this.n += 1;
            this.emit({ type: 'delta', n: this.n, text: piece });
          }
          if (truncated) {
            d.log.warn({ messageId: p.assistantId, maxReplyChars: d.cfg.maxReplyChars }, 'reply truncated by safety cap');
            break;
          }
        }
      } finally {
        await it.return?.(undefined as never).catch(() => undefined);
      }
      if (this.text.length === 0) throw new LlmError('模型沒有產生內容', 'EMPTY_REPLY', true);
      outcome = await this.complete();
    } catch (e) {
      outcome = 'failed';
      await this.fail(e);
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      clearInterval(flusher);
      clearInterval(renew);
      releaseSlot?.();
      d.metrics.outcomes.labels(outcome).inc();
      d.metrics.duration.observe((performance.now() - this.startedAt) / 1000);
      await this.closeRedisStream(this.terminal?.type === 'done' ? 'done' : 'error');
      await releaseLock(d.redis, lockKey(p.conversationId), p.assistantId).catch(() => undefined);
    }
  }

  private dto(status: MessageDto['status'], errorCode: string | null): MessageDto {
    return {
      id: this.p.assistantId,
      conversation_id: this.p.conversationId,
      seq: this.p.seq,
      role: 'assistant',
      content: this.text,
      status,
      error_code: errorCode,
      created_at: this.p.createdAt,
    };
  }

  /** 回覆完成:內容 + 狀態 + 「待結算」在同一個 DB transaction 內提交。 */
  private async complete(): Promise<string> {
    const { d, p } = this;
    // 單一語句(CTE):更新訊息 + 更新對話摘要,一次往返、整體原子。
    // 訊息已不是 streaming(被 reaper 判定中斷、或帳號已被刪除)時 m 為空,外層 UPDATE 也不會執行 → rowCount = 0
    const res = this.result;
    const upd = await d.pool.query(
      `WITH m AS (
         UPDATE messages
            SET content = $2, status = 'completed', cost = $3, model = $4,
                provider = $6, input_tokens = $7, output_tokens = $8,
                billing_state = 'settle_pending', completed_at = now()
          WHERE id = $1 AND status = 'streaming'
          RETURNING conversation_id
       )
       UPDATE conversations SET last_message_at = now(), last_preview = $5
         FROM m WHERE conversations.id = m.conversation_id`,
      [
        p.assistantId,
        this.text,
        p.character.price,
        res?.model ?? d.provider.defaultModel, // 實際回覆的模型(備援時和主要供應商不同)
        preview(this.text),
        res?.provider ?? null,
        res?.usage?.inputTokens ?? null,
        res?.usage?.outputTokens ?? null,
      ],
    );
    if (res?.usage) {
      d.metrics.llmTokens.labels(res.provider, 'input').inc(res.usage.inputTokens);
      d.metrics.llmTokens.labels(res.provider, 'output').inc(res.usage.outputTokens);
    }
    const ok = (upd.rowCount ?? 0) > 0;
    if (!ok) {
      d.log.warn({ messageId: p.assistantId }, 'completion skipped: message no longer streaming');
      this.emit({
        type: 'error',
        code: 'GENERATION_INTERRUPTED',
        message: USER_MESSAGES.GENERATION_INTERRUPTED!,
        retryable: true,
        state: this.dto('failed', 'GENERATION_INTERRUPTED'),
      });
      return 'superseded';
    }
    const msg = this.dto('completed', null);
    await d.recent.upsert(msg);
    // 快速路徑:立刻結算,拿到最新餘額給前端;失敗就留給 reaper(billing_state 仍是 settle_pending)
    const r = await settleHold(
      d,
      { id: p.assistantId, hold_ref: p.holdRef, conversation_id: p.conversationId, seq: p.seq },
      p.character.name,
    );
    this.emit({ type: 'done', message: msg, balance: r.balance });
    return 'completed';
  }

  private async fail(e: unknown): Promise<void> {
    const { d, p } = this;
    const c = classify(e, this.abort.signal);
    d.log.warn({ messageId: p.assistantId, code: c.code, err: (e as Error)?.message }, 'generation failed');
    try {
      const row = await markFailed(d, p.assistantId, this.text, c.code);
      if (row) {
        await d.recent.upsert(this.dto('failed', c.code));
        await releaseHold(d, { id: p.assistantId, hold_ref: p.holdRef });
      }
    } catch (err) {
      // DB 暫時不可用:訊息仍是 streaming,稍後 reaper 會接手(鎖過期後判定為孤兒)
      d.log.error({ messageId: p.assistantId, err: (err as Error).message }, 'failed to persist generation failure');
    }
    this.emit({ type: 'error', ...c, state: this.dto('failed', c.code) });
  }

  // ------------------------------------------------------------ Redis Stream(續傳/當機補救)
  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(() => this.flush()).catch(() => undefined);
  }

  private async flush(): Promise<void> {
    if (!this.pending) return;
    const text = this.pending;
    this.pending = '';
    try {
      const key = genStreamKey(this.p.assistantId);
      await this.d.redis
        .multi()
        .xadd(key, 'MAXLEN', '~', '5000', '*', 'n', String(this.n), 't', text)
        .expire(key, 900)
        .exec();
    } catch (e) {
      this.pending = text + this.pending; // 下次再試,不遺失
      this.d.log.debug({ err: (e as Error).message }, 'stream flush failed');
    }
  }

  private async closeRedisStream(end: 'done' | 'error'): Promise<void> {
    try {
      await this.flushChain;
      await this.flush();
      const key = genStreamKey(this.p.assistantId);
      // 結束標記後只保留很短時間:DB 已有最終內容,Redis 這份只是為了讓還在追的訂閱者收尾
      await this.d.redis.multi().xadd(key, '*', 'end', end).expire(key, 120).exec();
    } catch {
      /* 續傳資料遺失可接受,DB 才是真相 */
    }
  }
}

export class GenerationManager {
  private map = new Map<string, Generation>();
  constructor(private readonly d: Deps) {}

  get activeCount(): number {
    return this.map.size;
  }

  get(messageId: string): Generation | undefined {
    return this.map.get(messageId);
  }

  create(p: GenParams): Generation {
    const g = new Generation(this.d, p);
    this.map.set(p.assistantId, g);
    this.d.metrics.active.inc();
    return g;
  }

  /** 訂閱者都掛好之後才呼叫,避免漏掉最前面的片段。 */
  start(g: Generation): void {
    void g.run().finally(() => {
      this.map.delete(g.p.assistantId);
      this.d.metrics.active.dec();
    });
  }

  abortUser(userId: string): number {
    let n = 0;
    for (const g of this.map.values()) {
      if (g.p.userId === userId) {
        g.cancel(new LlmError('帳號已刪除', 'USER_DELETED', false));
        n++;
      }
    }
    return n;
  }

  /** 優雅關閉:先等進行中的回覆自然結束,逾時才強制中止(中止的訊息會被標記失敗並釋放點數)。 */
  async drain(waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (this.map.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const g of this.map.values()) g.cancel(new LlmError('服務重啟中', 'SERVER_RESTARTING', true));
    const grace = Date.now() + 3000;
    while (this.map.size > 0 && Date.now() < grace) await new Promise((r) => setTimeout(r, 100));
  }
}
