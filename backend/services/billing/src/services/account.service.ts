import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { tx, type Queryable } from '@chat-app/shared/db';
import { Errors } from '@chat-app/shared/errors';
import type { CacheAside } from '@chat-app/shared/redis';
import type { BillingConfig } from '../config';
import { AccountRepository } from '../repositories/account.repository';
import { HoldRepository } from '../repositories/hold.repository';
import { LedgerRepository } from '../repositories/ledger.repository';
import type { GrantInput, LedgerQuery } from '../schemas';
import { toBalance, type Balance } from '../types';

/** 帳戶:餘額查詢(含快取)、首次使用時開戶、入帳、帳本、刪除使用者資料 */
export class AccountService {
  private readonly accounts: AccountRepository;
  private readonly ledger: LedgerRepository;

  constructor(
    private readonly pool: Pool,
    private readonly balanceCache: CacheAside,
    private readonly cfg: Pick<BillingConfig, 'signupBonus' | 'balanceCacheTtlSec'>,
  ) {
    this.accounts = new AccountRepository(pool);
    this.ledger = new LedgerRepository(pool);
  }

  invalidateBalance(userId: string): Promise<void> {
    return this.balanceCache.del(`u:${userId}`);
  }

  /** 建立帳戶並發放註冊點數(以 signup:{uid} 為冪等鍵)。db 通常是 transaction 內的連線 */
  async ensureAccount(db: Queryable, userId: string): Promise<void> {
    const created = await new AccountRepository(db).createIfAbsent(userId, this.cfg.signupBonus);
    if (created && this.cfg.signupBonus > 0) {
      await new LedgerRepository(db).insertSignupGrant(userId, this.cfg.signupBonus);
    }
  }

  async readBalance(userId: string): Promise<Balance> {
    const b = await this.balanceCache.get<Balance>(`u:${userId}`, this.cfg.balanceCacheTtlSec, async () => {
      const row = await this.accounts.find(userId);
      if (row) return toBalance(row);
      await tx(this.pool, (c) => this.ensureAccount(c, userId));
      return toBalance((await this.accounts.find(userId))!);
    });
    return b!;
  }

  async bulkBalances(userIds: string[]): Promise<Record<string, Balance>> {
    const items: Record<string, Balance> = {};
    if (userIds.length === 0) return items;
    for (const r of await this.accounts.findMany(userIds)) items[r.user_id] = toBalance(r);
    return items;
  }

  async grant(b: GrantInput): Promise<{ ok: true; already: boolean; balance: number | null }> {
    const idem = b.idem_key ?? `admin:${randomUUID()}`;
    const out = await tx(this.pool, async (c) => {
      const ledger = new LedgerRepository(c);
      if (await ledger.existsIdem(idem)) return { already: true, balance: null as number | null };
      await this.ensureAccount(c, b.user_id);
      const balance = await new AccountRepository(c).addBalance(b.user_id, b.amount);
      const inserted = await ledger.insertGrant({ userId: b.user_id, amount: b.amount, balanceAfter: balance, idemKey: idem, note: b.reason });
      if (!inserted) throw Errors.conflict('GRANT_RACE', '重複的入帳請求');
      return { already: false, balance };
    });
    await this.invalidateBalance(b.user_id);
    return { ok: true, ...out };
  }

  async readLedger(userId: string, q: LedgerQuery) {
    const rows = await this.ledger.list(userId, q.before_id ?? null, q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).map((r) => ({
      ...r,
      id: Number(r.id),
      amount: Number(r.amount),
      balance_after: Number(r.balance_after),
    }));
    return { items, next_before_id: hasMore ? items[items.length - 1]!.id : null };
  }

  overview(): Promise<Record<string, number>> {
    return this.accounts.overview();
  }

  /** 刪除帳號事件:清掉這位使用者的帳本、預扣與帳戶(冪等) */
  async deleteUserData(userId: string): Promise<void> {
    await tx(this.pool, async (c) => {
      await new LedgerRepository(c).deleteByUser(userId);
      await new HoldRepository(c).deleteByUser(userId);
      await new AccountRepository(c).deleteByUser(userId);
    });
    await this.invalidateBalance(userId);
  }
}
