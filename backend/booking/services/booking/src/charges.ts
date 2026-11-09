import type { Pool, PoolClient } from 'pg';
import type { ServiceClient } from '../../../../shared/client';
import { AppError } from '../../../../shared/errors';
import type { Logger } from '../../../../shared/log';

export type ChargeKind = 'turn' | 'exec';
export type ChargeOutcome = 'settle' | 'release';

interface ChargeRow {
  ref: string;
  booking_id: string;
  kind: ChargeKind;
  amount: number;
  note: string;
  state: string;
}

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
export class Charges {
  constructor(
    private readonly pool: Pool,
    private readonly billing: ServiceClient,
    private readonly log: Logger,
    private readonly onFailure: () => void = () => undefined,
  ) {}

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
    await this.pool.query(
      `INSERT INTO charges (ref, booking_id, user_id, kind, amount, note, state)
       VALUES ($1,$2,$3,$4,$5,$6,'holding') ON CONFLICT (ref) DO NOTHING`,
      [c.ref, c.bookingId, c.userId, c.kind, c.amount, c.note],
    );
    try {
      await this.billing.post('/internal/holds', { ref: c.ref, user_id: c.userId, amount: c.amount, ttl_sec: c.ttlSec });
    } catch (e) {
      if (e instanceof AppError && e.status >= 400 && e.status < 500) {
        // 明確被拒絕(點數不足等):確定沒有預扣
        await this.setState(c.ref, 'released', ['holding', 'held']);
      } else {
        // 逾時 / 5xx:billing 可能已經預扣了。只有明確的 4xx 才能確定沒預扣,其餘一律當作有,交給 reaper 釋放。
        await this.setState(c.ref, 'release_pending', ['holding', 'held']);
        this.log.warn({ ref: c.ref, err: (e as Error).message }, 'hold result unknown, will release defensively');
      }
      throw e;
    }
    await this.setState(c.ref, 'held', ['holding']);
  }

  /** 在呼叫端的 DB transaction 內,決定這筆扣點的結局。回傳是否真的更新到(false = 沒有這筆或已經決定過) */
  async commitIn(tx: PoolClient, ref: string, outcome: ChargeOutcome): Promise<boolean> {
    const r = await tx.query(
      `UPDATE charges SET state = $2, updated_at = now() WHERE ref = $1 AND state IN ('holding','held')`,
      [ref, outcome === 'settle' ? 'settle_pending' : 'release_pending'],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** 沒走到提交(例如流程中途出錯、版本衝突)就放棄這筆預扣 */
  async abort(ref: string): Promise<void> {
    if (await this.setState(ref, 'release_pending', ['holding', 'held'])) await this.finalize(ref);
  }

  /** 通知 billing。回傳 true = 已完成(或沒事可做)。失敗只記錄,不丟錯 */
  async finalize(ref: string): Promise<boolean> {
    const { rows } = await this.pool.query<ChargeRow>('SELECT ref, booking_id, kind, amount, note, state FROM charges WHERE ref = $1', [ref]);
    const c = rows[0];
    if (!c || (c.state !== 'settle_pending' && c.state !== 'release_pending')) return true;
    try {
      if (c.state === 'settle_pending') {
        await this.billing.post('/internal/holds/settle', {
          ref,
          meta: {
            note: c.note,
            ref_type: c.kind === 'exec' ? 'booking' : 'booking_turn',
            booking_id: c.booking_id,
          },
        });
        await this.setState(ref, 'settled', ['settle_pending']);
      } else {
        await this.billing.post('/internal/holds/release', { ref });
        await this.setState(ref, 'released', ['release_pending']);
      }
      return true;
    } catch (e) {
      if (c.state === 'settle_pending' && e instanceof AppError && (e.status === 404 || e.status === 409)) {
        // 預扣已經被 billing 逾時釋放,無法再結算。重試也不會成功:如實記成沒扣到,並留下錯誤紀錄供對帳。
        this.log.error({ ref, code: e.code }, 'settle impossible: hold no longer active (service delivered, points not collected)');
        await this.setState(ref, 'released', ['settle_pending']);
        return true;
      }
      this.onFailure();
      this.log.warn({ ref, state: c.state, err: (e as Error).message }, 'billing call failed, will retry via reaper');
      return false;
    }
  }

  /** 背景補償:重送卡住的結算 / 釋放;並釋放「流程中斷、永遠不會有結局」的預扣 */
  async sweep(): Promise<number> {
    // 預扣之後流程就中斷了(程序當機)。turn 幾秒就會結束;exec 則要看訂位本身是否還在進行中。
    await this.pool.query(
      `UPDATE charges c SET state = 'release_pending', updated_at = now()
        WHERE c.state IN ('holding','held') AND c.updated_at < now() - interval '2 minutes'
          AND (c.kind = 'turn' OR NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.id = c.booking_id AND b.charge_ref = c.ref AND b.status IN ('confirmed','executing')))`,
    );
    const { rows } = await this.pool.query<{ ref: string }>(
      `SELECT ref FROM charges WHERE state IN ('settle_pending','release_pending') AND updated_at < now() - interval '5 seconds'
        ORDER BY updated_at LIMIT 50`,
    );
    let done = 0;
    for (const r of rows) if (await this.finalize(r.ref)) done++;
    return done;
  }

  private async setState(ref: string, to: string, from: string[]): Promise<boolean> {
    const r = await this.pool.query('UPDATE charges SET state = $2, updated_at = now() WHERE ref = $1 AND state = ANY($3::text[])', [ref, to, from]);
    return (r.rowCount ?? 0) > 0;
  }
}
