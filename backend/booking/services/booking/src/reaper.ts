import type { Deps } from './deps';
import type { Runner } from './runner';

/**
 * 背景補償任務(每個 booking instance 都會跑,彼此靠條件式 UPDATE / 租約避免重複工作):
 *
 *  1. 過期:確認期限已到的方案 → expired(使用者查詢時本來就會即時判斷為過期,這裡只是把狀態落地);
 *          太久沒動的草稿 → expired
 *  2. 接手:已確認、但沒有人在執行的訂位(程序當機、租約到期、或當時名額滿而讓出)→ 交給 runner。
 *          runner 會依 exec_phase 決定是重做、用同一個冪等鍵重送,還是標記為結果不明
 *  3. 點數:重送卡住的結算 / 釋放;釋放流程中斷而永遠不會有結局的預扣
 */
export class BookingReaper {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly d: Deps,
    private readonly runner: Runner,
    private readonly intervalMs = 5000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expire();
      await this.recover();
      await this.d.charges.sweep();
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'booking reaper tick failed');
    } finally {
      this.running = false;
    }
  }

  private async expire(): Promise<void> {
    const { pool, cfg } = this.d;
    const plans = await pool.query<{ id: string }>(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'awaiting_confirmation' AND expires_at < now() RETURNING id`,
    );
    const drafts = await pool.query<{ id: string }>(
      `UPDATE bookings SET status = 'expired', pending = NULL, finished_at = now(), version = version + 1, updated_at = now()
        WHERE status = 'collecting' AND updated_at < now() - make_interval(secs => $1) RETURNING id`,
      [cfg.draftTtlSec],
    );
    const ids = [...plans.rows, ...drafts.rows].map((r) => r.id);
    if (ids.length === 0) return;
    await pool.query(
      `INSERT INTO booking_events (booking_id, type, text, data)
       SELECT unnest($1::uuid[]), 'status', '已過期', '{"status":"expired"}'::jsonb`,
      [ids],
    );
    this.d.log.info({ plans: plans.rowCount, drafts: drafts.rowCount }, 'expired bookings');
  }

  private async recover(): Promise<void> {
    const { rows } = await this.d.pool.query<{ id: string }>(
      `SELECT id FROM bookings
        WHERE status IN ('confirmed','executing') AND (lease_until IS NULL OR lease_until < now())
          AND updated_at < now() - interval '5 seconds'
        ORDER BY updated_at LIMIT 10`,
    );
    for (const r of rows) {
      this.d.log.info({ id: r.id }, 'recovering booking without active runner');
      this.runner.start(r.id);
    }
  }
}
