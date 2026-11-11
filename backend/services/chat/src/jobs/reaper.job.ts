import type { Pool, PoolClient } from 'pg';
import { tx } from '@chat-app/shared/db';
import type { Logger } from '@chat-app/shared/log';
import type { RecentMessagesCache } from '../cache/recent-messages.cache';
import type { GenerationLock } from '../generation/generation-lock';
import type { GenerationStreamStore } from '../generation/stream-store';
import type { Metrics } from '../metrics';
import { MessageRepository, type OrphanCandidate } from '../repositories/message.repository';
import type { SettlementService } from '../services/settlement.service';

export interface ReaperDeps {
  pool: Pool;
  lock: GenerationLock;
  streamStore: GenerationStreamStore;
  recent: RecentMessagesCache;
  settlement: SettlementService;
  log: Logger;
  metrics: Metrics;
}

/**
 * 背景補償任務(每個 chat instance 都會跑)。孤兒處理用 FOR UPDATE SKIP LOCKED 避免重複;
 * 計費重試則允許多台偶爾重複執行,因為 billing 的 settle / release 都是冪等的:
 *
 * 1. 孤兒回覆:status='streaming' 但負責的 instance 已經不在(當機、被強制重啟)。
 *    判斷方式:生成中的 instance 每 ~10 秒續期 lock:gen:{conv},鎖的值是 AI 訊息 id。
 *    鎖不存在、或不屬於這則訊息 → 孤兒。把 Redis Stream 裡已產生的文字救回來,標記 failed,並進入 release_pending。
 * 2. 待結算/待釋放:回覆結束時呼叫 billing 失敗(billing 暫時不可用)的訊息,持續重試直到成功。
 *    billing 的 settle / release 都是冪等的,所以重試是安全的。
 */
export class ReaperJob {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly d: ReaperDeps,
    private readonly intervalMs = 15_000,
    private readonly orphanAfterMs = 45_000,
    private readonly hardLimitMs = 10 * 60_000,
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
      await this.reapOrphans();
      await this.retryBilling();
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'reaper tick failed');
    } finally {
      this.running = false;
    }
  }

  private async salvage(messageId: string): Promise<string> {
    return this.d.streamStore.readText(messageId).catch(() => '');
  }

  private async isAlive(m: OrphanCandidate): Promise<boolean> {
    try {
      return (await this.d.lock.owner(m.conversation_id)) === m.id;
    } catch {
      // Redis 不可用時無法判斷 → 只在超過硬上限(遠大於任何正常回覆)時才當孤兒
      return Date.now() - new Date(m.gen_started_at).getTime() < this.hardLimitMs;
    }
  }

  private async reapOrphans(): Promise<void> {
    const { d } = this;
    const orphans = await tx(d.pool, async (c: PoolClient) => {
      const messages = new MessageRepository(c);
      const rows = await messages.lockStaleStreaming(this.orphanAfterMs);
      const dead: OrphanCandidate[] = [];
      for (const m of rows) if (!(await this.isAlive(m))) dead.push(m);
      const out: Array<OrphanCandidate & { content: string }> = [];
      for (const m of dead) {
        const content = await this.salvage(m.id);
        await messages.markInterrupted(m.id, content);
        out.push({ ...m, content });
      }
      return out;
    });

    for (const m of orphans) {
      d.log.warn({ messageId: m.id, salvagedChars: m.content.length }, 'reaped orphan generation');
      d.metrics.outcomes.labels('orphaned').inc();
      await d.recent.upsert({
        id: m.id,
        conversation_id: m.conversation_id,
        seq: m.seq,
        role: 'assistant',
        content: m.content,
        status: 'failed',
        error_code: 'GENERATION_INTERRUPTED',
        created_at: new Date(m.created_at).toISOString(),
      });
      if (m.hold_ref) await d.settlement.release({ id: m.id, hold_ref: m.hold_ref });
    }
  }

  private async retryBilling(): Promise<void> {
    const { d } = this;
    const rows = await tx(d.pool, (c: PoolClient) => new MessageRepository(c).lockPendingBilling());
    for (const m of rows) {
      if (m.billing_state === 'settle_pending') await d.settlement.settle(m);
      else await d.settlement.release(m);
    }
    if (rows.length) d.log.info({ count: rows.length }, 'retried pending billing resolutions');

    // 訊息尚未寫入就失敗、且當下歸還預扣也失敗的:逐筆重試到成功為止
    const n = await d.settlement.retryDeferredReleases();
    if (n) d.log.info({ count: n }, 'processed pending releases');
  }
}
