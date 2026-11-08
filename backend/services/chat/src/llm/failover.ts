import type { Logger } from '../../../../shared/log';
import {
  isConfigError,
  LlmError,
  type BreakerStatus,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from './types';

/** 讓備援層回報指標,而不必依賴 prom-client(方便獨立測試) */
export interface LlmHooks {
  /** 每次對某個供應商的嘗試結果:ok 或錯誤碼 */
  attempt(provider: string, outcome: string): void;
  failover(from: string, to: string): void;
  breaker(provider: string, open: boolean): void;
}

export interface FailoverOptions {
  /** 每個供應商「第一個字」的等待上限。要遠小於整體逾時,否則主要供應商卡住時使用者得乾等 */
  firstTokenMs: number;
  /** 串流中途兩個片段之間的最長空窗(模型卡住) */
  stallMs: number;
  /** 連續失敗幾次後開路 */
  breakerFailures: number;
  /** 開路後多久才放一個探測請求進去 */
  breakerCooldownMs: number;
}

/**
 * 斷路器(每個供應商一個,每個 chat instance 各自獨立)。
 *
 * 為什麼需要:沒有它的話,主要供應商掛掉時,「每一個」使用者都要先等完首字逾時(例如 8 秒)才會換到備援,
 * 而且每個請求都在對一個已知壞掉的服務施壓。
 *   closed    正常
 *   open      連續失敗達門檻 → 在冷卻期內直接跳過這個供應商
 *   half-open 冷卻結束 → 只放「一個」探測請求;成功就回到 closed,失敗就再開路一輪
 */
class Breaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    readonly enabled: boolean,
  ) {}

  /** 回傳這個請求是否可以打這個供應商 */
  allow(now = Date.now()): boolean {
    if (!this.enabled || this.failures < this.threshold) return true;
    if (now - this.openedAt < this.cooldownMs) return false;
    if (this.probing) return false; // 已經有一個探測在進行,其他人先跳過
    this.probing = true;
    return true;
  }

  success(): boolean {
    const wasOpen = this.failures >= this.threshold;
    this.failures = 0;
    this.probing = false;
    return wasOpen; // 回傳「是否剛從開路恢復」
  }

  failure(now = Date.now()): boolean {
    if (!this.enabled) return false;
    const wasClosed = this.failures < this.threshold;
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) this.openedAt = now;
    return wasClosed && this.failures >= this.threshold; // 回傳「是否剛剛開路」
  }

  /** 探測請求被取消/不是供應商的問題時,把探測名額還回去 */
  releaseProbe(): void {
    this.probing = false;
  }

  state(now = Date.now()): BreakerStatus['state'] {
    if (!this.enabled) return 'disabled';
    if (this.failures < this.threshold) return 'closed';
    return now - this.openedAt < this.cooldownMs ? 'open' : 'half-open';
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
  get retryAt(): number {
    return this.failures >= this.threshold ? this.openedAt + this.cooldownMs : 0;
  }
}

interface Slot {
  provider: LlmProvider;
  breaker: Breaker;
}

/**
 * 備援鏈:依序嘗試各個供應商。
 *
 * 換手規則(這是刻意的取捨):
 *   - 只有在「還沒送出任何字」之前失敗,才會換下一個。這涵蓋絕大多數的故障型態:
 *     連線失敗、逾時、429、5xx、金鑰/設定錯誤、空回覆。
 *   - 已經送出部分文字再失敗,**不**偷偷換:使用者畫面上已經有字,中途換一個模型重寫會讓內容突然被取代,
 *     體驗和一致性都更糟。這種情況回報錯誤(不扣點),使用者重試時會重新走整條鏈。
 *   - 內容被安全機制擋下(failover = false)不算故障,不換手,避免換一家去繞過過濾。
 *   - 全部供應商都不可用 → LLM_UNAVAILABLE,由上層回覆「目前系統有問題」。
 */
export class FailoverProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  private readonly slots: Slot[];

  constructor(
    providers: LlmProvider[],
    private readonly opts: FailoverOptions,
    private readonly hooks: LlmHooks,
    private readonly log: Logger,
  ) {
    if (providers.length === 0) throw new Error('備援鏈至少需要一個供應商');
    this.slots = providers.map((provider) => ({
      provider,
      // mock 只用於開發/測試,它的 [[fail]] 模擬錯誤不應該讓斷路器開路
      breaker: new Breaker(opts.breakerFailures, opts.breakerCooldownMs, provider.name !== 'mock'),
    }));
    this.name = providers.map((p) => p.name).join('>');
    this.defaultModel = providers[0]!.defaultModel;
  }

  status(): BreakerStatus[] {
    return this.slots.map((s) => ({
      name: s.provider.name,
      model: s.provider.defaultModel,
      state: s.breaker.state(),
      consecutiveFailures: s.breaker.consecutiveFailures,
      retryAt: s.breaker.retryAt,
    }));
  }

  async *stream(req: LlmRequest): AsyncGenerator<string, LlmResult, void> {
    let previous: string | undefined; // 上一個失敗的供應商,用來記錄換手
    let attempted = 0;

    for (let i = 0; i < this.slots.length; i++) {
      const { provider, breaker } = this.slots[i]!;
      if (!breaker.allow()) {
        this.log.debug({ provider: provider.name }, 'llm provider skipped: circuit open');
        continue;
      }
      attempted++;
      if (previous) this.hooks.failover(previous, provider.name);

      // 每次嘗試有自己的 AbortController:逾時只中止這一次嘗試,而不是整個生成
      const attempt = new AbortController();
      const onOuterAbort = () => attempt.abort(req.signal.reason);
      if (req.signal.aborted) onOuterAbort();
      else req.signal.addEventListener('abort', onOuterAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number, code: string, msg: string) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => attempt.abort(new LlmError(msg, code, true)), ms);
      };
      arm(this.opts.firstTokenMs, 'FIRST_TOKEN_TIMEOUT', `${provider.name} 在 ${this.opts.firstTokenMs}ms 內沒有回應`);

      let emitted = false;
      // 角色指定的模型(req.model)只對主要供應商有意義:模型名稱是各家專屬的,送給備援會被拒絕
      const model = i === 0 ? req.model : undefined;
      const it = provider.stream({ ...req, model, signal: attempt.signal });
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) {
            if (breaker.success()) {
              this.hooks.breaker(provider.name, false);
              this.log.info({ provider: provider.name }, 'llm provider recovered: circuit closed');
            }
            this.hooks.attempt(provider.name, 'ok');
            return { ...r.value, provider: provider.name };
          }
          emitted = true;
          arm(this.opts.stallMs, 'LLM_ERROR', `${provider.name} 串流停滯超過 ${this.opts.stallMs}ms`);
          yield r.value;
        }
      } catch (e) {
        if (timer) clearTimeout(timer);

        // 上層取消(使用者刪帳號、伺服器關機、整體逾時…)不是供應商的問題:不計入斷路器、不換手
        if (req.signal.aborted) {
          breaker.releaseProbe();
          throw e;
        }
        const err = this.normalize(e, attempt.signal);
        this.hooks.attempt(provider.name, err.code);

        // 不是供應商健康問題的錯誤(例如這則內容被安全機制擋下)不得計入斷路器:
        // 否則任何一位使用者連送幾則會被擋的訊息,就能把整個供應商「打開路」,害所有人都被導去備援。
        if (!err.failover) {
          breaker.releaseProbe();
          this.log.info({ provider: provider.name, code: err.code }, 'llm request declined (not a provider fault)');
          throw err;
        }
        const opened = breaker.failure();
        if (opened) {
          this.hooks.breaker(provider.name, true);
          this.log.error(
            { provider: provider.name, failures: this.opts.breakerFailures, cooldownMs: this.opts.breakerCooldownMs },
            'llm provider circuit OPEN',
          );
        }
        this.log[isConfigError(err) ? 'error' : 'warn'](
          { provider: provider.name, code: err.code, status: err.status, emitted, err: err.message },
          isConfigError(err) ? 'llm provider rejected request (check API key / model name / parameters)' : 'llm provider failed',
        );

        if (emitted) throw err; // 已經有字送出去了,不能無縫換手
        previous = provider.name;
      } finally {
        if (timer) clearTimeout(timer);
        req.signal.removeEventListener('abort', onOuterAbort);
        // 消費端提前中止(break / return)或這次嘗試失敗時,關閉底層串流(取消 fetch)
        await it.return?.(undefined as never).catch(() => undefined);
      }
    }

    // 走到這裡 = 沒有任何供應商能服務這個請求(全部失敗,或全部在斷路冷卻中)
    this.hooks.attempt('chain', 'unavailable');
    this.log.error({ attempted, providers: this.slots.length }, 'all llm providers unavailable');
    throw new LlmError(
      attempted === 0 ? '所有模型供應商都在斷路冷卻中' : '所有模型供應商都無法回應',
      'LLM_UNAVAILABLE',
      true,
      false,
    );
  }

  private normalize(e: unknown, attemptSignal: AbortSignal): LlmError {
    // 這次嘗試被自己的逾時計時器中止:reason 就是我們塞進去的 LlmError
    if (attemptSignal.aborted && attemptSignal.reason instanceof LlmError) return attemptSignal.reason;
    if (e instanceof LlmError) return e;
    return new LlmError(`模型呼叫失敗:${(e as Error)?.message ?? e}`, 'LLM_ERROR', true);
  }
}
