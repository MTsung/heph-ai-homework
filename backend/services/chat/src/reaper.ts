import type { PoolClient } from 'pg';
import { tx } from '../../../shared/db';
import { releaseHold, settleHold } from './billing';
import { genStreamKey, lockKey, type Deps } from './deps';

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
export class Reaper {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly d: Deps,
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
    try {
      const entries = (await this.d.redis.xrange(genStreamKey(messageId), '-', '+')) as Array<[string, string[]]>;
      let text = '';
      for (const [, fields] of entries) {
        for (let i = 0; i < fields.length; i += 2) if (fields[i] === 't') text += fields[i + 1];
      }
      return text;
    } catch {
      return '';
    }
  }

  private async reapOrphans(): Promise<void> {
    const { d } = this;
    const orphans = await tx(d.pool, async (c: PoolClient) => {
      const { rows } = await c.query<{
        id: string;
        conversation_id: string;
        seq: number;
        hold_ref: string | null;
        gen_started_at: Date;
        created_at: Date;
      }>(
        `SELECT id, conversation_id, seq, hold_ref, gen_started_at, created_at FROM messages
          WHERE status = 'streaming' AND gen_started_at < now() - ($1::int * interval '1 millisecond')
          ORDER BY gen_started_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
        [this.orphanAfterMs],
      );
      const dead: typeof rows = [];
      for (const m of rows) {
        let alive = false;
        try {
          alive = (await d.redis.get(lockKey(m.conversation_id))) === m.id;
        } catch {
          // Redis 不可用時無法判斷 → 只在超過硬上限(遠大於任何正常回覆)時才當孤兒
          alive = Date.now() - new Date(m.gen_started_at).getTime() < this.hardLimitMs;
        }
        if (!alive) dead.push(m);
      }
      const out: Array<{ id: string; conversation_id: string; seq: number; hold_ref: string | null; content: string; created_at: Date }> = [];
      for (const m of dead) {
        const content = await this.salvage(m.id);
        await c.query(
          `UPDATE messages SET content = $2, status = 'failed', error_code = 'GENERATION_INTERRUPTED',
                  billing_state = CASE WHEN hold_ref IS NULL THEN 'none' ELSE 'release_pending' END,
                  completed_at = now()
            WHERE id = $1`,
          [m.id, content],
        );
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
      if (m.hold_ref) await releaseHold(d, { id: m.id, hold_ref: m.hold_ref });
    }
  }

  private async retryBilling(): Promise<void> {
    const { d } = this;
    const rows = await tx(d.pool, async (c: PoolClient) => {
      const r = await c.query<{
        id: string;
        conversation_id: string;
        seq: number;
        hold_ref: string;
        billing_state: 'settle_pending' | 'release_pending';
        character_id: string;
      }>(
        `SELECT m.id, m.conversation_id, m.seq, m.hold_ref, m.billing_state, c.character_id
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.billing_state IN ('settle_pending','release_pending')
            AND m.hold_ref IS NOT NULL AND m.completed_at < now() - interval '5 seconds'
          ORDER BY m.completed_at LIMIT 20 FOR UPDATE OF m SKIP LOCKED`,
      );
      return r.rows;
    });
    for (const m of rows) {
      if (m.billing_state === 'settle_pending') await settleHold(d, m);
      else await releaseHold(d, m);
    }
    if (rows.length) d.log.info({ count: rows.length }, 'retried pending billing resolutions');

    // 訊息尚未寫入就失敗、且當下歸還預扣也失敗的:逐筆重試到成功為止
    const pend = await d.pool.query<{ hold_ref: string }>(
      `SELECT hold_ref FROM pending_releases ORDER BY created_at LIMIT 50`,
    );
    for (const p of pend.rows) {
      try {
        await d.billing.post('/internal/holds/release', { ref: p.hold_ref });
        await d.pool.query('DELETE FROM pending_releases WHERE hold_ref = $1', [p.hold_ref]);
      } catch (e) {
        await d.pool.query('UPDATE pending_releases SET attempts = attempts + 1 WHERE hold_ref = $1', [p.hold_ref]);
        d.log.warn({ holdRef: p.hold_ref, err: (e as Error).message }, 'pending release still failing');
      }
    }
    if (pend.rows.length) d.log.info({ count: pend.rows.length }, 'processed pending releases');
  }
}
