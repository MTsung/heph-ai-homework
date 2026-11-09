import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { tx } from '../../../../shared/db';
import type { Deps } from './deps';
import type { BookingChannel, BookingRow, BookingResult, BookingStatus, Plan, SubmitOutcome } from './types';

class LeaseLost extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 結果不明時給使用者看的說明 */
const UNKNOWN_RESULT: BookingResult = {
  ok: false,
  code: 'RESULT_UNKNOWN',
  message: '訂位已送出,但沒有收到店家的明確回覆,無法確定有沒有訂成。為避免重複訂位,系統不會自動重送,這次也不會扣點。請直接聯絡店家確認。',
};

/**
 * 執行已確認的訂位。重點在「當機後怎麼辦」:
 *
 *   claim      以條件式 UPDATE 取得執行權(租約),同一筆訂位同時只會有一個 instance 在做
 *   heartbeat  執行期間定期續租;程序當機就停止續租,租約到期後別的 instance 接手
 *   write-ahead 送出請求「之前」先把 exec_phase 寫成 submitting。接手者看到這個記號就知道請求可能已經送達:
 *                 - 管道有冪等鍵(平台 API):用同一個鍵重送,對方保證不會重複訂位
 *                 - 沒有(網頁表單):不重送,標記為「結果不明」並請使用者向店家確認
 *              看到 pre_submit 則代表什麼都還沒送出,直接重做即可
 *
 * 這和 chat 服務的「結果未知」是同一類問題:逾時不等於失敗,不能把不確定當成失敗去重試。
 */
export class Runner {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly owner = `${hostname()}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly d: Deps) {}

  get active(): number {
    return this.inflight.size;
  }

  start(id: string): void {
    if (this.inflight.has(id)) return;
    const p = this.run(id)
      .catch((e) => this.d.log.error({ id, err: (e as Error).message, stack: (e as Error).stack }, 'booking run crashed; reaper will recover'))
      .finally(() => {
        this.inflight.delete(id);
        this.d.metrics.executing.set(this.inflight.size);
      });
    this.inflight.set(id, p);
    this.d.metrics.executing.set(this.inflight.size);
  }

  /** 關機時等進行中的執行結束(沒結束的會由別的 instance 接手) */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inflight.values()]), sleep(timeoutMs)]);
  }

  private async claim(id: string): Promise<BookingRow | null> {
    const r = await this.d.pool.query<BookingRow>(
      `UPDATE bookings
          SET status = 'executing', lease_owner = $2, lease_until = now() + make_interval(secs => $3),
              attempt = attempt + 1, version = version + 1, updated_at = now()
        WHERE id = $1 AND (status = 'confirmed' OR (status = 'executing' AND lease_until < now()))
        RETURNING *`,
      [id, this.owner, this.d.cfg.leaseSec],
    );
    return r.rows[0] ?? null;
  }

  private async unclaim(id: string): Promise<void> {
    await this.d.pool.query(
      `UPDATE bookings SET status = 'confirmed', lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
      [id, this.owner],
    );
  }

  private async run(id: string): Promise<void> {
    const { d } = this;
    const row = await this.claim(id);
    if (!row) return; // 別的 instance 已經在做,或已經結束
    const plan = row.confirmed_plan as Plan;
    const channel = d.channels[plan.target.channel];

    // 接手一筆「可能已送出」的訂位,而這個管道沒有冪等保證 → 絕不重送
    if (row.exec_phase === 'submitting' && !channel.idempotent) {
      d.log.warn({ id, attempt: row.attempt }, 'previous attempt may have submitted; channel is not idempotent → marking result unknown');
      await this.finish(row, { kind: 'ambiguous', reason: 'interrupted after submit' });
      return;
    }
    // 排太久還沒開始送出 → 放棄(送出階段的不受限:已經在途中了)
    const waited = (Date.now() - new Date(row.confirmed_at!).getTime()) / 1000;
    if (row.exec_phase !== 'submitting' && waited > d.cfg.execDeadlineSec) {
      await this.finish(row, { kind: 'rejected', code: 'EXECUTION_TIMEOUT', message: '系統一直沒有機會處理這筆訂位,已放棄(尚未送出訂位)。請重新建立。' });
      return;
    }
    // 需要操作網頁的管道有同時執行上限;confirm 時已經搶過名額,這裡是冪等地再確認一次(接手時需要)
    if (channel.limited) {
      const ok = await d.limiter.acquire(id).catch(() => false);
      if (!ok) {
        await this.unclaim(id); // 留給 reaper 稍後重試
        return;
      }
    }

    const beat = setInterval(() => {
      void d.pool
        .query(
          `UPDATE bookings SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
          [id, this.owner, d.cfg.leaseSec],
        )
        .catch(() => undefined);
      if (channel.limited) void d.limiter.renew(id).catch(() => undefined);
    }, (d.cfg.leaseSec * 1000) / 3);

    let outcome: SubmitOutcome | null;
    try {
      outcome = await this.submitWithRetry(row, plan, channel);
    } finally {
      clearInterval(beat);
      if (channel.limited) await d.limiter.release(id).catch(() => undefined);
    }
    if (outcome) await this.finish(row, outcome);
  }

  private async submitWithRetry(row: BookingRow, plan: Plan, channel: BookingChannel): Promise<SubmitOutcome | null> {
    const { d } = this;
    let sent = row.exec_phase === 'submitting';
    const beforeSend = async () => {
      const r = await d.pool.query(
        `UPDATE bookings SET exec_phase = 'submitting', updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = 'executing'`,
        [row.id, this.owner],
      );
      if (!r.rowCount) throw new LeaseLost(); // 執行權已經被別人拿走,不可以再送
      sent = true;
    };

    for (let attempt = 1; ; attempt++) {
      let out: SubmitOutcome;
      try {
        out = await channel.submit(plan, row.id, beforeSend, AbortSignal.timeout(d.cfg.submitTimeoutMs));
      } catch (e) {
        if (e instanceof LeaseLost) return null;
        d.log.error({ id: row.id, err: (e as Error).message }, 'channel threw');
        // 還沒進入送出階段就出錯 → 確定沒送;否則結果不明
        out = sent
          ? { kind: 'ambiguous', reason: `exception: ${(e as Error).message}` }
          : { kind: 'rejected', code: 'INTERNAL_ERROR', message: '系統發生錯誤,尚未送出訂位。' };
      }
      // 結果不明且管道保證冪等 → 同一個鍵重送是安全的
      if (out.kind === 'ambiguous' && channel.idempotent && attempt < 3) {
        d.log.warn({ id: row.id, attempt, reason: out.reason }, 'ambiguous result, retrying with same idempotency key');
        await sleep(500 * attempt);
        continue;
      }
      return out;
    }
  }

  /** 把結果和扣點的結局在同一個 transaction 提交 */
  async finish(row: Pick<BookingRow, 'id' | 'user_id' | 'confirmed_plan' | 'charge_ref'>, out: SubmitOutcome): Promise<void> {
    const { d } = this;
    const channelId = (row.confirmed_plan as Plan).target.channel;
    let status: BookingStatus;
    let result: BookingResult;
    if (out.kind === 'success') {
      status = 'succeeded';
      result = { ok: true, confirmation_no: out.confirmationNo, ...(out.trace ? { trace: out.trace } : {}) };
    } else if (out.kind === 'rejected') {
      status = 'failed';
      result = { ok: false, code: out.code, message: out.message, ...(out.trace ? { trace: out.trace } : {}) };
    } else {
      status = 'unknown';
      result = { ...UNKNOWN_RESULT, ...(out.stage ? { stage: out.stage } : {}), ...(out.trace ? { trace: out.trace } : {}) };
      // 不記錄 worker 的自由文字(reason):它可能含第三方頁面內容。stage 是白名單的執行階段,可安全供客服診斷。
      d.log.warn({ id: row.id, channel: channelId, stage: out.stage, reason: out.reason.slice(0, 200) }, 'booking result unknown');
    }
    const ref = row.charge_ref;
    const text =
      status === 'succeeded'
        ? `訂位成功!訂位代號 ${(result as { confirmation_no: string }).confirmation_no}`
        : status === 'failed'
          ? `沒有訂成:${(result as { message: string }).message}(不會扣點)`
          : result.ok
            ? ''
            : result.message;

    const updated = await tx(d.pool, async (c) => {
      const r = await c.query(
        `UPDATE bookings
            SET status = $2, result = $3, pending = NULL, exec_phase = NULL, lease_owner = NULL, lease_until = NULL,
                finished_at = now(), updated_at = now(), version = version + 1
          WHERE id = $1 AND status IN ('executing','confirmed')`,
        [row.id, status, JSON.stringify(result)],
      );
      if (!r.rowCount) return false; // 已經由別人結束了
      await c.query(`INSERT INTO booking_events (booking_id, type, text, data) VALUES ($1,'status',$2,$3)`, [
        row.id,
        text,
        JSON.stringify({ status, result }),
      ]);
      if (ref) await d.charges.commitIn(c, ref, status === 'succeeded' ? 'settle' : 'release');
      return true;
    });
    if (!updated) return;
    d.metrics.executions.labels(channelId, status).inc();
    d.log.info({ id: row.id, status, channel: channelId }, 'booking finished');
    if (ref) await d.charges.finalize(ref);
  }
}
