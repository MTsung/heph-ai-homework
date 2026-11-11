import type { Pool } from 'pg';
import { Errors } from '@chat-app/shared/errors';
import type { BookingConfig } from '../config';
import type { Nlu } from '../domain/nlu';
import { BookingEventRepository } from '../repositories/booking-event.repository';
import { BookingRepository } from '../repositories/booking.repository';
import type { ChargeRepository } from '../repositories/charge.repository';
import { toView } from '../views/booking.view';
import type { BookingRunner } from './booking-runner';
import type { ConcurrencyLimiter } from './concurrency-limiter';

/** 後台 / 客服用的唯讀查詢(不檢查 owner;只經 internal token 存取) */
export class InspectionService {
  private readonly bookings: BookingRepository;
  private readonly events: BookingEventRepository;

  constructor(
    pool: Pool,
    private readonly chargeRepo: ChargeRepository,
    private readonly limiter: ConcurrencyLimiter,
    private readonly runner: BookingRunner,
    private readonly nlu: Nlu,
    private readonly cfg: BookingConfig,
  ) {
    this.bookings = new BookingRepository(pool);
    this.events = new BookingEventRepository(pool);
  }

  async listByUser(userId: string, limit: number) {
    const rows = await this.bookings.listByUser(userId, limit);
    return { items: rows.map((r) => ({ ...toView(this.cfg, r), user_id: r.user_id })) };
  }

  async get(id: string) {
    const row = await this.bookings.findById(id);
    if (!row) throw Errors.notFound('找不到訂位需求');
    const [events, charges] = await Promise.all([this.events.listForBooking(id), this.chargeRepo.listForBookingAdmin(id)]);
    return { ...toView(this.cfg, row, { events, charges }), user_id: row.user_id, exec: { phase: row.exec_phase, attempt: row.attempt } };
  }

  async stats() {
    const [bookings, charges] = await Promise.all([this.bookings.countByStatus(), this.chargeRepo.countByState()]);
    return {
      bookings,
      charges,
      executing_slots: { in_use: await this.limiter.inUse().catch(() => null), max: this.cfg.maxConcurrent },
      running_this_instance: this.runner.active,
      nlu: this.nlu.mode,
    };
  }
}
