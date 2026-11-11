import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '@chat-app/shared/errors';
import type { Logger } from '@chat-app/shared/log';
import type { BillingClient } from '../clients/billing.client';
import { ChargeRepository, type ChargeKind } from '../repositories/charge.repository';

export type { ChargeKind };
export type ChargeOutcome = 'settle' | 'release';

/**
 * 每次扣點「嘗試」都用全新的 ref(billing 的預扣以 ref 為冪等鍵,且結束後的 ref 不能再用)。
 * 訊息 / 確認本身的冪等不靠 ref,而是靠 client_msg_id 與狀態的條件式更新。
 */
export const newTurnRef = (bookingId: string) => `bk:${bookingId}:turn:${randomUUID()}`;
export const newExecRef = (bookingId: string) => `bk:${bookingId}:book:${randomUUID()}`;

/**
 * 訂位服務的點數流程。沿用 chat 的做法(預扣 → 結算 / 釋放,不用分散式交易),差別是把「走到哪一步」
 * 存在自己的 charges 表,而不是掛在訊息上:
 *
 *   begin()            先寫 holding,再向 billing 預扣(冪等,以 ref 為鍵),成功改 held
 *   commitIn(tx, ...)  在「改變訂位狀態」的同一個 DB transaction 裡,把這筆扣點標成 settle_pending 或 release_pending
 *   finalize()         通知 billing 結算 / 釋放,成功改 settled / released。失敗不要緊 —— 狀態已經決定,reaper 會重試
 *
 * 所以「該扣還是該退」永遠和訂位結果一起提交,不會出現「訂位成功但沒扣」或「失敗卻扣了」的中間狀態。
 */
export class ChargeService {
  private readonly charges: ChargeRepository;

  constructor(
    pool: Pool,
    private readonly billing: BillingClient,
    private readonly log: Logger,
    private readonly onFailure: () => void = () => undefined,
  ) {
    this.charges = new ChargeRepository(pool);
  }

  /** 預扣。點數不足 → 402(此時 billing 沒有留下任何預扣)。結果不明(逾時 / 5xx)→ 標記為待釋放並丟 503 */
  async begin(c: {
    ref: string;
    bookingId: string;
    userId: string;
    kind: ChargeKind;
    amount: number;
    note: string;
    ttlSec: number;
  }): Promise<void> {
    await this.charges.insertHolding(c);
    try {
      await this.billing.hold(c.ref, c.userId, c.amount, c.ttlSec);
    } catch (e) {
      if (e instanceof AppError && e.status >= 400 && e.status < 500) {
        // 明確被拒絕(點數不足等):確定沒有預扣
        await this.charges.transition(c.ref, 'released', ['holding', 'held']);
      } else {
        // 逾時 / 5xx:billing 可能已經預扣了。只有明確的 4xx 才能確定沒預扣,其餘一律當作有,交給 reaper 釋放。
        await this.charges.transition(c.ref, 'release_pending', ['holding', 'held']);
        this.log.warn({ ref: c.ref, err: (e as Error).message }, 'hold result unknown, will release defensively');
      }
      throw e;
    }
    await this.charges.transition(c.ref, 'held', ['holding']);
  }

  /** 在呼叫端的 DB transaction 內,決定這筆扣點的結局。回傳是否真的更新到(false = 沒有這筆或已經決定過) */
  commitIn(tx: PoolClient, ref: string, outcome: ChargeOutcome): Promise<boolean> {
    return new ChargeRepository(tx).transition(ref, outcome === 'settle' ? 'settle_pending' : 'release_pending', ['holding', 'held']);
  }

  /** 沒走到提交(例如流程中途出錯、版本衝突)就放棄這筆預扣 */
  async abort(ref: string): Promise<void> {
    if (await this.charges.transition(ref, 'release_pending', ['holding', 'held'])) await this.finalize(ref);
  }

  /** 通知 billing。回傳 true = 已完成(或沒事可做)。失敗只記錄,不丟錯 */
  async finalize(ref: string): Promise<boolean> {
    const c = await this.charges.find(ref);
    if (!c || (c.state !== 'settle_pending' && c.state !== 'release_pending')) return true;
    try {
      if (c.state === 'settle_pending') {
        await this.billing.settle(ref, {
          note: c.note,
          ref_type: c.kind === 'exec' ? 'booking' : 'booking_turn',
          booking_id: c.booking_id,
        });
        await this.charges.transition(ref, 'settled', ['settle_pending']);
      } else {
        await this.billing.release(ref);
        await this.charges.transition(ref, 'released', ['release_pending']);
      }
      return true;
    } catch (e) {
      if (c.state === 'settle_pending' && e instanceof AppError && (e.status === 404 || e.status === 409)) {
        // 預扣已經被 billing 逾時釋放,無法再結算。重試也不會成功:如實記成沒扣到,並留下錯誤紀錄供對帳。
        this.log.error({ ref, code: e.code }, 'settle impossible: hold no longer active (service delivered, points not collected)');
        await this.charges.transition(ref, 'released', ['settle_pending']);
        return true;
      }
      this.onFailure();
      this.log.warn({ ref, state: c.state, err: (e as Error).message }, 'billing call failed, will retry via reaper');
      return false;
    }
  }

  /** 背景補償:重送卡住的結算 / 釋放;並釋放「流程中斷、永遠不會有結局」的預扣 */
  async sweep(): Promise<number> {
    await this.charges.abandonStale();
    const refs = await this.charges.listPending(50);
    let done = 0;
    for (const ref of refs) if (await this.finalize(ref)) done++;
    return done;
  }
}
