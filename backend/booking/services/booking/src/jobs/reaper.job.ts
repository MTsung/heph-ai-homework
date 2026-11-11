import type { Pool } from 'pg';
import type { Logger } from '@chat-app/shared/log';
import type { BookingConfig } from '../config';
import { BookingEventRepository } from '../repositories/booking-event.repository';
import { BookingRepository } from '../repositories/booking.repository';
import type { BookingRunner } from '../services/booking-runner';
import type { ChargeService } from '../services/charge.service';

/**
 * 背景補償任務(每個 booking instance 都會跑,彼此靠條件式 UPDATE / 租約避免重複工作):
 *
 *  1. 過期:確認期限已到的方案 → expired(使用者查詢時本來就會即時判斷為過期,這裡只是把狀態落地);
 *          太久沒動的草稿 → expired
 *  2. 接手:已確認、但沒有人在執行的訂位(程序當機、租約到期、或當時名額滿而讓出)→ 交給 runner。
 *          runner 會依 exec_phase 決定是重做、用同一個冪等鍵重送,還是標記為結果不明
 *  3. 點數:重送卡住的結算 / 釋放;釋放流程中斷而永遠不會有結局的預扣
 */
export class BookingReaperJob {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly bookings: BookingRepository;
  private readonly events: BookingEventRepository;

  constructor(
    pool: Pool,
    private readonly runner: BookingRunner,
    private readonly charges: ChargeService,
    private readonly log: Logger,
    private readonly cfg: Pick<BookingConfig, 'draftTtlSec'>,
    private readonly intervalMs = 5000,
  ) {
    this.bookings = new BookingRepository(pool);
    this.events = new BookingEventRepository(pool);
  }

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
      await this.charges.sweep();
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'booking reaper tick failed');
    } finally {
      this.running = false;
    }
  }

  private async expire(): Promise<void> {
    const plans = await this.bookings.expirePlans();
    const drafts = await this.bookings.expireStaleDrafts(this.cfg.draftTtlSec);
    const ids = [...plans, ...drafts];
    if (ids.length === 0) return;
    await this.events.addExpired(ids);
    this.log.info({ plans: plans.length, drafts: drafts.length }, 'expired bookings');
  }

  private async recover(): Promise<void> {
    for (const id of await this.bookings.listUnattended()) {
      this.log.info({ id }, 'recovering booking without active runner');
      this.runner.start(id);
    }
  }
}
