import type { Pool } from 'pg';
import { tx } from '@chat-app/shared/db';
import { AppError } from '@chat-app/shared/errors';
import type { Logger } from '@chat-app/shared/log';
import type { BillingClient } from '../clients/billing.client';
import type { CharacterDirectory } from '../clients/character.client';
import type { Metrics } from '../metrics';
import { MessageRepository } from '../repositories/message.repository';
import { PendingReleaseRepository } from '../repositories/pending-release.repository';

export interface BillingTarget {
  id: string;
  hold_ref: string;
  conversation_id: string;
  seq: number;
  character_id?: string;
}

/**
 * 結算(settle)與釋放(release)點數,給「回覆完成當下的快速路徑」與「reaper 補償」共用。
 *
 * 點數一致性靠這個狀態機,不靠分散式交易:
 *   held ──(回覆完成,同一個 DB tx)──▶ settle_pending ──(billing 成功)──▶ settled
 *   held ──(回覆失敗/中斷)──────────▶ release_pending ──(billing 成功)──▶ released
 * billing 的 settle / release 都是冪等的,所以呼叫失敗、逾時、重送都安全,
 * pending 狀態的訊息會被 reaper 持續重試,直到成功為止。
 */
export class SettlementService {
  private readonly pendingReleases: PendingReleaseRepository;

  constructor(
    private readonly pool: Pool,
    private readonly billing: BillingClient,
    private readonly directory: CharacterDirectory,
    private readonly log: Logger,
    private readonly metrics: Metrics,
  ) {
    this.pendingReleases = new PendingReleaseRepository(pool);
  }

  async settle(m: BillingTarget, characterName?: string): Promise<{ done: boolean; balance: number | null }> {
    let name = characterName;
    if (!name && m.character_id) {
      name = await this.directory
        .get(m.character_id)
        .then((c) => c.name)
        .catch(() => undefined);
    }
    try {
      const r = await this.billing.settle(m.hold_ref, {
        note: name ? `與${name}的對話` : 'AI 回覆',
        conversation_id: m.conversation_id,
        message_id: m.id,
        seq: m.seq,
      });
      await this.markBillingState(m.id, 'settle_pending', 'settled');
      return { done: true, balance: r.balance };
    } catch (e) {
      if (e instanceof AppError && (e.status === 409 || e.status === 404)) {
        // 預扣已被釋放(逾時)或不存在:重試也不會成功。標記完成避免無限重試,並留下警告供對帳。
        this.log.error({ messageId: m.id, holdRef: m.hold_ref, code: e.code }, 'settle impossible: hold not active (revenue leak)');
        await this.markBillingState(m.id, 'settle_pending', 'settled').catch(() => undefined);
        return { done: true, balance: null };
      }
      this.metrics.settleFailures.inc();
      this.log.warn({ messageId: m.id, err: (e as Error).message }, 'settle failed, will retry via reaper');
      return { done: false, balance: null };
    }
  }

  async release(m: Pick<BillingTarget, 'id' | 'hold_ref'>): Promise<boolean> {
    try {
      await this.billing.release(m.hold_ref);
      await this.markBillingState(m.id, 'release_pending', 'released');
      return true;
    } catch (e) {
      this.metrics.settleFailures.inc();
      this.log.warn({ messageId: m.id, err: (e as Error).message }, 'release failed, will retry via reaper');
      return false;
    }
  }

  /**
   * 還沒有 messages 列可掛狀態時的補償 release(預扣後、訊息寫入前就失敗)。
   * 先嘗試同步歸還;失敗(例如 billing 此刻過載)就記到 pending_releases,由 reaper 重試到成功。
   * 絕不靜默吞掉失敗:否則使用者的點數會被凍結到 billing 的逾時清理(預設 10 分鐘)才歸還。
   */
  async releaseOrDefer(holdRef: string): Promise<void> {
    try {
      await this.billing.release(holdRef);
    } catch (e) {
      this.metrics.settleFailures.inc();
      this.log.warn({ holdRef, err: (e as Error).message }, 'release failed, deferred to reaper');
      await this.pendingReleases
        .add(holdRef)
        .catch((err) => this.log.error({ holdRef, err: (err as Error).message }, 'could not even record pending release'));
    }
  }

  /** 逐筆重試 pending_releases,成功就移除。回傳這次處理的筆數 */
  async retryDeferredReleases(): Promise<number> {
    const refs = await this.pendingReleases.listOldest(50);
    for (const ref of refs) {
      try {
        await this.billing.release(ref);
        await this.pendingReleases.remove(ref);
      } catch (e) {
        await this.pendingReleases.recordAttempt(ref);
        this.log.warn({ holdRef: ref, err: (e as Error).message }, 'pending release still failing');
      }
    }
    return refs.length;
  }

  /**
   * 純簿記的狀態更新(settle_pending → settled 等):不需要同步等 WAL fsync。
   * 這個更新就算在 crash 時遺失也完全安全 —— 訊息會維持 settle_pending,reaper 會再呼叫一次 billing,
   * 而 billing 的 settle / release 是冪等的。真正與金額相關的寫入(預扣、結算、訊息完成)都保持同步 commit,
   * 所以耐久性沒有降低,只是少掉一次可省的 fsync。
   * 只在這一筆交易內關閉 synchronous_commit(SET LOCAL),不影響其他交易。
   */
  private async markBillingState(messageId: string, from: string, to: string): Promise<void> {
    await tx(this.pool, async (c) => {
      await c.query('SET LOCAL synchronous_commit = off');
      await new MessageRepository(c).setBillingState(messageId, from, to);
    });
  }
}
