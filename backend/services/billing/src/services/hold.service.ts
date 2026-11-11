import type { Pool } from 'pg';
import { tx } from '@chat-app/shared/db';
import { AppError, Errors } from '@chat-app/shared/errors';
import type { BillingConfig } from '../config';
import { AccountRepository } from '../repositories/account.repository';
import { HoldRepository } from '../repositories/hold.repository';
import type { HoldInput, ResolveInput } from '../schemas';
import type { AccountService } from './account.service';

/**
 * 預扣 → 結算 / 釋放。三個操作都以 ref 為冪等鍵,呼叫端(chat、booking)逾時重送都安全。
 * SQL 細節(為什麼不會超扣、為什麼單一語句就是原子的)見 repositories/hold.repository.ts。
 */
export class HoldService {
  private readonly holds: HoldRepository;
  private readonly accountRepo: AccountRepository;

  constructor(
    private readonly pool: Pool,
    private readonly accounts: AccountService,
    private readonly cfg: Pick<BillingConfig, 'defaultHoldTtlSec'>,
  ) {
    this.holds = new HoldRepository(pool);
    this.accountRepo = new AccountRepository(pool);
  }

  async hold(b: HoldInput) {
    const ttlSec = b.ttl_sec ?? this.cfg.defaultHoldTtlSec;
    let accountEnsured = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let row;
      try {
        row = await this.holds.tryHold({ ref: b.ref, userId: b.user_id, amount: b.amount, ttlSec });
      } catch (e) {
        if ((e as { code?: string }).code === '23505') continue; // 同 ref 並發建立:整條語句已回滾,重試會走冪等分支
        throw e;
      }
      if (row.ex_status) {
        if (row.ex_status === 'held') return { ref: b.ref, amount: row.ex_amount, idempotent: true };
        throw Errors.conflict('HOLD_ALREADY_RESOLVED', '這筆預扣已經結算或釋放');
      }
      if (row.inserted > 0) {
        const balance = Number(row.balance);
        const held = Number(row.held);
        return { ref: b.ref, amount: b.amount, idempotent: false, balance, available: balance - held };
      }
      // 沒有更新到列:帳戶還不存在(首次使用),或餘額不足
      const cur = await this.accountRepo.find(b.user_id);
      if (!cur && !accountEnsured) {
        await tx(this.pool, (c) => this.accounts.ensureAccount(c, b.user_id));
        accountEnsured = true;
        continue;
      }
      const balance = Number(cur?.balance ?? 0);
      const heldNow = Number(cur?.held ?? 0);
      if (balance - heldNow >= b.amount) continue; // 剛好有人釋放了點數,再試一次
      throw new AppError(402, 'INSUFFICIENT_POINTS', '點數不足', {
        required: b.amount,
        balance,
        available: balance - heldNow,
      });
    }
    throw Errors.unavailable('系統繁忙,請稍後再試');
  }

  async settle(b: ResolveInput) {
    const note = (b.meta?.note as string | undefined) ?? 'AI 回覆';
    // 帳本的 ref_type 讓呼叫端標示扣點來源(chat 不帶 → 'message';booking 帶 'booking_turn' / 'booking')
    const refType = typeof b.meta?.ref_type === 'string' ? b.meta.ref_type.slice(0, 32) : null;
    const row = await this.holds.settle({ ref: b.ref, note, meta: JSON.stringify(b.meta ?? {}), refType });
    if (row.user_id) {
      await this.accounts.invalidateBalance(row.user_id);
      return { ok: true, already: false, balance: row.balance === null ? null : Number(row.balance) };
    }
    // h 沒有列:已經結算過(冪等重送)、已被釋放、或根本不存在
    const status = await this.holds.findStatus(b.ref);
    if (!status) throw Errors.notFound('找不到預扣紀錄');
    if (status === 'settled') return { ok: true, already: true, balance: null };
    throw Errors.conflict('HOLD_RELEASED', '預扣已被釋放(可能已逾時),無法結算');
  }

  async release(b: { ref: string }) {
    const userId = await tx(this.pool, async (c) => {
      const h = await new HoldRepository(c).markReleased(b.ref);
      if (!h) return null; // 不存在 / 已結算 / 已釋放:冪等,視為成功
      await new AccountRepository(c).releaseHeld(h.user_id, h.amount);
      return h.user_id;
    });
    if (userId) await this.accounts.invalidateBalance(userId);
    return { ok: true, already: userId === null };
  }

  /** chat 服務若在預扣後當掉,hold 不會被結算也不會被釋放;定期把逾時的 hold 還給使用者。回傳釋放筆數 */
  async releaseExpired(): Promise<number> {
    const released = await tx(this.pool, async (c) => {
      const holds = new HoldRepository(c);
      const accounts = new AccountRepository(c);
      const rows = await holds.lockExpired(200);
      for (const h of rows) {
        await holds.setReleased(h.ref);
        await accounts.releaseHeld(h.user_id, h.amount);
      }
      return rows;
    });
    for (const h of released) await this.accounts.invalidateBalance(h.user_id);
    return released.length;
  }
}
