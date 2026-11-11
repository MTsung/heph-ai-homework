import type { Logger } from '@chat-app/shared/log';
import type { HoldService } from '../services/hold.service';

/** 定期釋放逾時的預扣(每個 billing instance 都會跑,彼此以 FOR UPDATE SKIP LOCKED 分工) */
export class HoldSweeperJob {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly holds: HoldService,
    private readonly log: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const n = await this.holds.releaseExpired();
      if (n) this.log.warn({ count: n }, 'released expired holds');
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'sweep failed');
    }
  }
}
