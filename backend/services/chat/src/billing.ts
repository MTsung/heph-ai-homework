import { AppError } from '../../../shared/errors';
import type { Deps } from './deps';

export interface BillingTarget {
  id: string;
  hold_ref: string;
  conversation_id: string;
  seq: number;
  character_id?: string;
}

/**
 * 純簿記的狀態更新(settle_pending → settled 等):不需要同步等 WAL fsync。
 * 這個更新就算在 crash 時遺失也完全安全 —— 訊息會維持 settle_pending,reaper 會再呼叫一次 billing,
 * 而 billing 的 settle / release 是冪等的。真正與金額相關的寫入(預扣、結算、訊息完成)都保持同步 commit,
 * 所以耐久性沒有降低,只是少掉一次可省的 fsync。
 * 只在這一筆交易內關閉 synchronous_commit(SET LOCAL),不影響其他交易。
 */
async function markBillingState(d: Pick<Deps, 'pool'>, messageId: string, from: string, to: string): Promise<void> {
  const c = await d.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL synchronous_commit = off');
    await c.query('UPDATE messages SET billing_state = $3 WHERE id = $1 AND billing_state = $2', [messageId, from, to]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * 結算(settle)與釋放(release)的共用實作,給「回覆完成當下的快速路徑」與「reaper 補償」使用。
 *
 * 點數一致性靠這個狀態機,不靠分散式交易:
 *   held ──(回覆完成,同一個 DB tx)──▶ settle_pending ──(billing 成功)──▶ settled
 *   held ──(回覆失敗/中斷)──────────▶ release_pending ──(billing 成功)──▶ released
 * billing 的 settle / release 都是冪等的,所以呼叫失敗、逾時、重送都安全,
 * pending 狀態的訊息會被 reaper 持續重試,直到成功為止。
 */
export async function settleHold(
  d: Pick<Deps, 'pool' | 'billing' | 'log' | 'metrics' | 'directory'>,
  m: BillingTarget,
  characterName?: string,
): Promise<{ done: boolean; balance: number | null }> {
  let name = characterName;
  if (!name && m.character_id) {
    name = await d.directory
      .get(m.character_id)
      .then((c) => c.name)
      .catch(() => undefined);
  }
  try {
    const r = await d.billing.post<{ balance: number | null }>('/internal/holds/settle', {
      ref: m.hold_ref,
      meta: {
        note: name ? `與${name}的對話` : 'AI 回覆',
        conversation_id: m.conversation_id,
        message_id: m.id,
        seq: m.seq,
      },
    });
    await markBillingState(d, m.id, 'settle_pending', 'settled');
    return { done: true, balance: r.balance };
  } catch (e) {
    if (e instanceof AppError && (e.status === 409 || e.status === 404)) {
      // 預扣已被釋放(逾時)或不存在:重試也不會成功。標記完成避免無限重試,並留下警告供對帳。
      d.log.error({ messageId: m.id, holdRef: m.hold_ref, code: e.code }, 'settle impossible: hold not active (revenue leak)');
      await markBillingState(d, m.id, 'settle_pending', 'settled').catch(() => undefined);
      return { done: true, balance: null };
    }
    d.metrics.settleFailures.inc();
    d.log.warn({ messageId: m.id, err: (e as Error).message }, 'settle failed, will retry via reaper');
    return { done: false, balance: null };
  }
}

export async function releaseHold(
  d: Pick<Deps, 'pool' | 'billing' | 'log' | 'metrics'>,
  m: Pick<BillingTarget, 'id' | 'hold_ref'>,
): Promise<boolean> {
  try {
    await d.billing.post('/internal/holds/release', { ref: m.hold_ref });
    await markBillingState(d, m.id, 'release_pending', 'released');
    return true;
  } catch (e) {
    d.metrics.settleFailures.inc();
    d.log.warn({ messageId: m.id, err: (e as Error).message }, 'release failed, will retry via reaper');
    return false;
  }
}

/**
 * 還沒有 messages 列可掛狀態時的補償 release(預扣後、訊息寫入前就失敗)。
 * 先嘗試同步歸還;失敗(例如 billing 此刻過載)就記到 pending_releases,由 reaper 重試到成功。
 * 絕不靜默吞掉失敗:否則使用者的點數會被凍結到 billing 的逾時清理(預設 10 分鐘)才歸還。
 */
export async function releaseOrDefer(d: Pick<Deps, 'pool' | 'billing' | 'log' | 'metrics'>, holdRef: string): Promise<void> {
  try {
    await d.billing.post('/internal/holds/release', { ref: holdRef });
  } catch (e) {
    d.metrics.settleFailures.inc();
    d.log.warn({ holdRef, err: (e as Error).message }, 'release failed, deferred to reaper');
    await d.pool
      .query('INSERT INTO pending_releases (hold_ref) VALUES ($1) ON CONFLICT DO NOTHING', [holdRef])
      .catch((err) => d.log.error({ holdRef, err: (err as Error).message }, 'could not even record pending release'));
  }
}

/** 把訊息標成 failed 並進入 release_pending(單一語句)。回傳 null 表示訊息已不是 streaming(例如已被 reaper 處理)。 */
export async function markFailed(
  d: Pick<Deps, 'pool'>,
  messageId: string,
  content: string,
  errorCode: string,
): Promise<{ created_at: string } | null> {
  const r = await d.pool.query<{ created_at: string }>(
    `UPDATE messages
        SET content = $2, status = 'failed', error_code = $3,
            billing_state = 'release_pending', completed_at = now()
      WHERE id = $1 AND status = 'streaming'
      RETURNING created_at`,
    [messageId, content, errorCode],
  );
  return r.rows[0] ?? null;
}
