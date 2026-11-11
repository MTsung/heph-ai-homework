import type { Queryable } from '@chat-app/shared/db';
import type { FullMessageRow, MessageDto, MessageRow } from '../types';

const MSG_COLS =
  'id, conversation_id, user_id, seq, role, content, status, error_code, client_msg_id, attempt, hold_ref, billing_state, created_at';

export interface OrphanCandidate {
  id: string;
  conversation_id: string;
  seq: number;
  hold_ref: string | null;
  gen_started_at: Date;
  created_at: Date;
}

export interface PendingBilling {
  id: string;
  conversation_id: string;
  seq: number;
  hold_ref: string;
  billing_state: 'settle_pending' | 'release_pending';
  character_id: string;
}

export class MessageRepository {
  constructor(private readonly db: Queryable) {}

  // ---------------------------------------------------------------- 讀取
  async findById(id: string): Promise<MessageRow | undefined> {
    const { rows } = await this.db.query<MessageRow>(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [id]);
    return rows[0];
  }

  async findByClientMsgId(conversationId: string, clientMsgId: string): Promise<MessageRow | undefined> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND client_msg_id = $2`,
      [conversationId, clientMsgId],
    );
    return rows[0];
  }

  async findBySeq(conversationId: string, seq: number): Promise<MessageRow | undefined> {
    const { rows } = await this.db.query<MessageRow>(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND seq = $2`, [
      conversationId,
      seq,
    ]);
    return rows[0];
  }

  async findAssistant(conversationId: string, messageId: string): Promise<MessageRow | undefined> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'`,
      [messageId, conversationId],
    );
    return rows[0];
  }

  /** 補同步:seq > afterSeq,由舊到新 */
  async listAfter(conversationId: string, afterSeq: number, limit: number): Promise<MessageRow[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [conversationId, afterSeq, limit],
    );
    return rows;
  }

  /** 往上滑:keyset WHERE seq < ? ORDER BY seq DESC(beforeSeq = null 表示最新一頁),由新到舊 */
  async listBefore(conversationId: string, beforeSeq: number | null, limit: number): Promise<MessageRow[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
        WHERE conversation_id = $1 AND ($2::int IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [conversationId, beforeSeq, limit],
    );
    return rows;
  }

  /** 最近 N 則(最近訊息快取的資料來源),由舊到新 */
  async listRecent(conversationId: string, size: number): Promise<MessageDto[]> {
    const { rows } = await this.db.query<MessageDto>(
      `SELECT id, conversation_id, seq, role, content, status, error_code, client_msg_id, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2`,
      [conversationId, size],
    );
    return rows.reverse();
  }

  // ---------------------------------------------------------------- 寫入
  /** 角色的開場白(seq=1) */
  async insertGreeting(m: { id: string; conversationId: string; userId: string; content: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, status)
       VALUES ($1, $2, $3, 1, 'assistant', $4, 'completed')`,
      [m.id, m.conversationId, m.userId, m.content],
    );
  }

  /**
   * 配號 + 寫入 user 訊息與 AI 訊息(placeholder)。
   * 單一語句(CTE):一次往返、一次 commit,整體原子。
   * UPDATE conversations 會對該列加 row lock,所以同一個對話內 seq 嚴格遞增、沒有空洞。
   * 同一個 client_msg_id 並發寫入時丟 PostgreSQL 23505。
   */
  async insertExchange(x: {
    conversationId: string;
    userMessageId: string;
    userId: string;
    content: string;
    clientMsgId: string;
    assistantId: string;
    model: string;
    holdRef: string;
  }): Promise<{ user: MessageRow; assistant: MessageRow }> {
    const ins = await this.db.query<{ u: MessageRow; a: MessageRow }>(
      `WITH s AS (
         UPDATE conversations SET next_seq = next_seq + 2, last_message_at = now()
          WHERE id = $1 RETURNING next_seq - 2 AS seq
       ),
       u AS (
         INSERT INTO messages (id, conversation_id, user_id, seq, role, content, status, client_msg_id)
         SELECT $2, $1, $3, s.seq, 'user', $4, 'completed', $5 FROM s
         RETURNING ${MSG_COLS}
       ),
       a AS (
         INSERT INTO messages (id, conversation_id, user_id, seq, role, content, status, attempt, model, hold_ref, billing_state)
         SELECT $6, $1, $3, s.seq + 1, 'assistant', '', 'streaming', 0, $7, $8, 'held' FROM s
         RETURNING ${MSG_COLS}
       )
       SELECT (SELECT row_to_json(u) FROM u) AS u, (SELECT row_to_json(a) FROM a) AS a`,
      [x.conversationId, x.userMessageId, x.userId, x.content, x.clientMsgId, x.assistantId, x.model, x.holdRef],
    );
    return { user: ins.rows[0]!.u, assistant: ins.rows[0]!.a };
  }

  /** 重試失敗的回覆:沿用同一則 AI 訊息(同 seq)。訊息已不是 failed 時回傳 undefined */
  async restartFailed(id: string, attempt: number, holdRef: string): Promise<MessageRow | undefined> {
    const upd = await this.db.query<MessageRow>(
      `UPDATE messages
          SET status = 'streaming', content = '', attempt = $2, error_code = NULL, hold_ref = $3,
              billing_state = 'held', completed_at = NULL, gen_started_at = now()
        WHERE id = $1 AND status = 'failed' RETURNING ${MSG_COLS}`,
      [id, attempt, holdRef],
    );
    return upd.rows[0];
  }

  /**
   * 回覆完成:內容 + 狀態 + 「待結算」與對話摘要,單一語句(CTE)一次往返、整體原子。
   * 訊息已不是 streaming(被 reaper 判定中斷、或帳號已被刪除)時不更新任何東西,回傳 false。
   */
  async complete(m: {
    id: string;
    content: string;
    cost: number;
    model: string;
    preview: string;
    provider: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }): Promise<boolean> {
    const upd = await this.db.query(
      `WITH m AS (
         UPDATE messages
            SET content = $2, status = 'completed', cost = $3, model = $4,
                provider = $6, input_tokens = $7, output_tokens = $8,
                billing_state = 'settle_pending', completed_at = now()
          WHERE id = $1 AND status = 'streaming'
          RETURNING conversation_id
       )
       UPDATE conversations SET last_message_at = now(), last_preview = $5
         FROM m WHERE conversations.id = m.conversation_id`,
      [m.id, m.content, m.cost, m.model, m.preview, m.provider, m.inputTokens, m.outputTokens],
    );
    return (upd.rowCount ?? 0) > 0;
  }

  /** 把訊息標成 failed 並進入 release_pending(單一語句)。回傳 null 表示訊息已不是 streaming(例如已被 reaper 處理)。 */
  async markFailed(id: string, content: string, errorCode: string): Promise<{ created_at: string } | null> {
    const r = await this.db.query<{ created_at: string }>(
      `UPDATE messages
          SET content = $2, status = 'failed', error_code = $3,
              billing_state = 'release_pending', completed_at = now()
        WHERE id = $1 AND status = 'streaming'
        RETURNING created_at`,
      [id, content, errorCode],
    );
    return r.rows[0] ?? null;
  }

  async setBillingState(id: string, from: string, to: string): Promise<void> {
    await this.db.query('UPDATE messages SET billing_state = $3 WHERE id = $1 AND billing_state = $2', [id, from, to]);
  }

  /** 分批刪除一位使用者的訊息,避免一個超大 transaction 長時間鎖表。回傳這批刪了幾筆 */
  async deleteBatchByUser(userId: string, batchSize: number): Promise<number> {
    const r = await this.db.query('DELETE FROM messages WHERE ctid IN (SELECT ctid FROM messages WHERE user_id = $1 LIMIT $2)', [
      userId,
      batchSize,
    ]);
    return r.rowCount ?? 0;
  }

  // ---------------------------------------------------------------- reaper(必須在 transaction 內呼叫)
  /** 鎖住一批「生成中太久」的訊息(FOR UPDATE SKIP LOCKED:多台 instance 不會重複處理) */
  async lockStaleStreaming(olderThanMs: number): Promise<OrphanCandidate[]> {
    const { rows } = await this.db.query<OrphanCandidate>(
      `SELECT id, conversation_id, seq, hold_ref, gen_started_at, created_at FROM messages
        WHERE status = 'streaming' AND gen_started_at < now() - ($1::int * interval '1 millisecond')
        ORDER BY gen_started_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [olderThanMs],
    );
    return rows;
  }

  async markInterrupted(id: string, salvagedContent: string): Promise<void> {
    await this.db.query(
      `UPDATE messages SET content = $2, status = 'failed', error_code = 'GENERATION_INTERRUPTED',
              billing_state = CASE WHEN hold_ref IS NULL THEN 'none' ELSE 'release_pending' END,
              completed_at = now()
        WHERE id = $1`,
      [id, salvagedContent],
    );
  }

  /** 鎖住一批待結算 / 待釋放的訊息 */
  async lockPendingBilling(): Promise<PendingBilling[]> {
    const r = await this.db.query<PendingBilling>(
      `SELECT m.id, m.conversation_id, m.seq, m.hold_ref, m.billing_state, c.character_id
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.billing_state IN ('settle_pending','release_pending')
          AND m.hold_ref IS NOT NULL AND m.completed_at < now() - interval '5 seconds'
        ORDER BY m.completed_at LIMIT 20 FOR UPDATE OF m SKIP LOCKED`,
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- 後台 / 除錯
  async listForAdmin(conversationId: string, beforeSeq: number | null, limit: number): Promise<unknown[]> {
    const { rows } = await this.db.query(
      `SELECT id, conversation_id, seq, role, content, status, error_code, attempt, cost, billing_state,
              model, provider, input_tokens, output_tokens, created_at
         FROM messages WHERE conversation_id = $1 AND ($2::int IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [conversationId, beforeSeq, limit],
    );
    return rows;
  }

  async findFull(id: string): Promise<FullMessageRow | undefined> {
    const { rows } = await this.db.query<FullMessageRow>('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0];
  }

  async stats(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM conversations) AS conversations,
              (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM messages WHERE status = 'streaming') AS streaming_now,
              (SELECT count(*) FROM messages WHERE status = 'failed') AS failed_total,
              (SELECT count(*) FROM messages WHERE billing_state IN ('settle_pending','release_pending')) AS billing_pending`,
    );
    return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]));
  }
}
