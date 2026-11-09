import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { readJson, requireUser, type AppEnv, type Ctx } from '../../../shared/app';
import { tx } from '../../../shared/db';
import { AppError, Errors, parse } from '../../../shared/errors';
import { acquireLock, releaseLock } from '../../../shared/redis';
import { SseStream } from '../../../shared/sse';
import { releaseOrDefer } from './billing';
import type { CharacterInfo } from './characters';
import { genStreamKey, lockKey, type Deps } from './deps';
import { Generation, GenerationManager, type GenEvent } from './generation';
import type { ChatMsg } from '../../../shared/llm';
import type { MessageDto } from './recent';

interface MessageRow {
  id: string;
  conversation_id: string;
  user_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  status: 'completed' | 'streaming' | 'failed';
  error_code: string | null;
  client_msg_id: string | null;
  attempt: number;
  hold_ref: string | null;
  billing_state: string;
  created_at: Date | string;
}

const MSG_COLS =
  'id, conversation_id, user_id, seq, role, content, status, error_code, client_msg_id, attempt, hold_ref, billing_state, created_at';

export function toDto(r: MessageRow): MessageDto {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    status: r.status,
    error_code: r.error_code,
    client_msg_id: r.client_msg_id,
    created_at: new Date(r.created_at).toISOString(),
  };
}

const uuid = z.string().uuid();

/**
 * 對話的 owner / character 在建立後永遠不變 → 適合放行程內快取(L1),
 * 每次送訊息、翻歷史都要驗證「這個對話是不是你的」,不需要每次都查 DB。
 */
class ConversationIndex {
  private map = new Map<string, { userId: string; characterId: string; exp: number }>();
  constructor(
    private readonly d: Deps,
    private readonly max = 50_000,
    private readonly ttlMs = 600_000,
  ) {}

  /** 非本人的對話一律回 404(不洩漏對話是否存在)。 */
  async owned(convId: string, userId: string): Promise<{ id: string; characterId: string }> {
    const hit = this.map.get(convId);
    if (hit && hit.exp > Date.now()) {
      if (hit.userId !== userId) throw Errors.notFound('找不到對話');
      return { id: convId, characterId: hit.characterId };
    }
    const { rows } = await this.d.pool.query<{ user_id: string; character_id: string }>(
      'SELECT user_id, character_id FROM conversations WHERE id = $1',
      [convId],
    );
    const row = rows[0];
    if (!row || row.user_id !== userId) throw Errors.notFound('找不到對話');
    if (this.map.size >= this.max) this.map.clear();
    this.map.set(convId, { userId: row.user_id, characterId: row.character_id, exp: Date.now() + this.ttlMs });
    return { id: convId, characterId: row.character_id };
  }

  forget(convId: string): void {
    this.map.delete(convId);
  }
}

const sendSchema = (maxChars: number) =>
  z.object({
    content: z.string().trim().min(1, '訊息不可為空').max(maxChars, `訊息最長 ${maxChars} 字`),
    client_msg_id: z.string().min(8).max(64),
  });

const historyQuery = z.object({
  before_seq: z.coerce.number().int().min(1).optional(),
  after_seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export function registerRoutes(app: Hono<AppEnv>, d: Deps, manager: GenerationManager, isDraining: () => boolean): { index: ConversationIndex } {
  const { pool, redis, cfg } = d;
  const index = new ConversationIndex(d);

  // ======================================================================= 對話
  app.get('/conversations', async (c) => {
    const { userId } = requireUser(c);
    const { rows } = await pool.query(
      `SELECT id, character_id, last_message_at, last_preview, next_seq - 1 AS latest_seq, created_at
         FROM conversations WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 200`,
      [userId],
    );
    return c.json({ items: rows });
  });

  app.post('/conversations', async (c) => {
    const { userId } = requireUser(c);
    const { character_id } = parse(z.object({ character_id: uuid }), await readJson(c));
    let character: CharacterInfo;
    try {
      character = await d.directory.get(character_id);
    } catch (e) {
      if (e instanceof AppError && e.status === 404) throw Errors.notFound('角色不存在');
      throw e;
    }
    if (character.status !== 'active') throw Errors.notFound('角色不存在');

    const created = await tx(pool, async (cl) => {
      const ins = await cl.query<{ id: string }>(
        `INSERT INTO conversations (id, user_id, character_id, next_seq)
         VALUES ($1, $2, $3, 2) ON CONFLICT (user_id, character_id) DO NOTHING RETURNING id`,
        [randomUUID(), userId, character_id],
      );
      if (!ins.rows[0]) return null;
      // 角色的開場白當作第一則訊息(seq=1),讓對話一開始就有內容
      await cl.query(
        `INSERT INTO messages (id, conversation_id, user_id, seq, role, content, status)
         VALUES ($1, $2, $3, 1, 'assistant', $4, 'completed')`,
        [randomUUID(), ins.rows[0].id, userId, character.greeting],
      );
      await cl.query('UPDATE conversations SET last_preview = $2 WHERE id = $1', [ins.rows[0].id, character.greeting.slice(0, 60)]);
      return ins.rows[0].id;
    });
    const { rows } = await pool.query(
      `SELECT id, character_id, last_message_at, last_preview, next_seq - 1 AS latest_seq, created_at
         FROM conversations WHERE user_id = $1 AND character_id = $2`,
      [userId, character_id],
    );
    return c.json(rows[0], created ? 201 : 200);
  });

  // ======================================================================= 歷史訊息
  /**
   * 三種讀法,全部以 seq(對話內嚴格遞增、無空洞)當游標,不用 offset、也不用時間戳:
   *   (無參數)    最新一頁   → 優先讀 Redis 最近訊息快取
   *   before_seq  往上滑     → keyset:WHERE seq < ? ORDER BY seq DESC LIMIT ?,走 UNIQUE(conversation_id, seq)
   *   after_seq   補同步     → 另一台裝置/重新連線後,把漏掉的訊息撈回來
   */
  app.get('/conversations/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const q = parse(historyQuery, c.req.query());
    await index.owned(convId, userId);

    if (q.after_seq !== undefined) {
      const { rows } = await pool.query<MessageRow>(
        `SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [convId, q.after_seq, q.limit],
      );
      return c.json({ items: rows.map(toDto), has_more_before: false, has_more_after: rows.length === q.limit });
    }

    if (q.before_seq === undefined) {
      const cached = await d.recent.get(convId);
      // 快取涵蓋得夠(或已經包含對話的第一則)才直接用,否則走 DB
      if (cached.length > 0 && (cached.length >= q.limit || cached[0]!.seq === 1)) {
        const items = cached.slice(-q.limit);
        return c.json({ items, has_more_before: items[0]!.seq > 1, has_more_after: false });
      }
    }

    const { rows } = await pool.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
        WHERE conversation_id = $1 AND ($2::int IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [convId, q.before_seq ?? null, q.limit + 1],
    );
    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).reverse().map(toDto);
    return c.json({ items, has_more_before: hasMore, has_more_after: false });
  });

  // ======================================================================= 組 LLM 上下文
  async function buildMessages(
    character: CharacterInfo,
    convId: string,
    beforeSeq: number,
    userText: string,
  ): Promise<ChatMsg[]> {
    const history = (await d.recent.get(convId)).filter(
      (m) => m.seq < beforeSeq && (m.role === 'user' || m.status === 'completed'),
    );
    // 成本控制(輸入端):每次請求都要把這些重送給模型並計費,所以三道上限——
    //  1. 最多 contextMessages 則  2. 總字元不超過 contextChars  3. 單則歷史超過 contextMsgMaxChars 就截斷
    // 越新的訊息越重要,所以由新往舊挑,預算用完就停;被截斷的只留開頭(結尾通常是展開的細節)。
    const picked: ChatMsg[] = [];
    let chars = userText.length;
    for (let i = history.length - 1; i >= 0 && picked.length < cfg.contextMessages; i--) {
      const m = history[i]!;
      const content =
        m.content.length > cfg.contextMsgMaxChars ? `${m.content.slice(0, cfg.contextMsgMaxChars)}…` : m.content;
      if (chars + content.length > cfg.contextChars && picked.length > 0) break;
      chars += content.length;
      picked.unshift({ role: m.role, content });
    }
    return [{ role: 'system', content: character.persona }, ...picked, { role: 'user', content: userText }];
  }

  // ======================================================================= SSE 輸出
  function forward(sse: SseStream, e: GenEvent): void {
    if (e.type === 'delta') {
      sse.send('delta', { t: e.text }, e.n);
    } else if (e.type === 'done') {
      sse.send('done', { message: e.message, balance: e.balance });
      sse.end();
    } else {
      sse.send('error', { code: e.code, message: e.message, retryable: e.retryable, state: e.state });
      sse.end();
    }
  }

  /** 附著到本機進行中的生成:先送目前累積的 snapshot,之後即時轉發。 */
  function attachLocal(sse: SseStream, gen: Generation): void {
    const sub = gen.subscribe((e) => forward(sse, e));
    if (sub.text) sse.send('snapshot', { id: gen.p.assistantId, content: sub.text, n: sub.n });
    sse.onClose(sub.unsubscribe); // 斷線只取消訂閱,生成繼續跑
  }

  /** 生成不在這台 instance:輪詢 Redis Stream 追進度,直到結束標記或 DB 狀態已結束。 */
  async function followRemote(sse: SseStream, msg: MessageRow): Promise<void> {
    let lastId = '-';
    let text = '';
    let first = true;
    let tick = 0;
    while (!sse.isClosed) {
      const entries = (await redis
        .xrange(genStreamKey(msg.id), lastId === '-' ? '-' : `(${lastId}`, '+', 'COUNT', 200)
        .catch(() => [])) as Array<[string, string[]]>;
      let ended = false;
      const deltas: Array<{ n: number; t: string }> = [];
      for (const [id, fields] of entries) {
        lastId = id;
        const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
        if (f.end) ended = true;
        else if (f.t !== undefined) {
          text += f.t;
          deltas.push({ n: Number(f.n), t: f.t });
        }
      }
      if (first) {
        if (text) sse.send('snapshot', { id: msg.id, content: text, n: deltas.at(-1)?.n ?? 0 });
        first = false;
      } else {
        for (const x of deltas) sse.send('delta', { t: x.t }, x.n);
      }
      tick += 1;
      // 看到結束標記,或每 ~1 秒對一次 DB:訊息若已不是 streaming(完成、失敗、或原 instance 當掉後被 reaper 收掉)就收尾
      if (ended || tick % 4 === 0) {
        const { rows } = await pool.query<MessageRow>(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [msg.id]);
        const cur = rows[0];
        if (!cur) {
          sse.end();
          return;
        }
        if (cur.status !== 'streaming') {
          sendTerminal(sse, cur, false); // 前面已經用 snapshot/delta 送過內容,done.message 帶最終全文
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** 訊息已經是終態(完成/失敗)時的輸出:一次送出完整內容。 */
  function sendTerminal(sse: SseStream, m: MessageRow, withSnapshot: boolean): void {
    const dto = toDto(m);
    if (withSnapshot && m.content) sse.send('snapshot', { id: m.id, content: m.content, n: 0 });
    if (m.status === 'completed') sse.send('done', { message: dto, balance: null });
    else
      sse.send('error', {
        code: m.error_code ?? 'GENERATION_INTERRUPTED',
        message: '回覆中斷,請重試',
        retryable: true,
        state: dto,
      });
    sse.end();
  }

  function streamExisting(c: Ctx, user: MessageRow | null, asst: MessageRow): Response {
    const sse = new SseStream(c);
    if (user) sse.send('user_message', toDto(user));
    sse.send('assistant_start', { id: asst.id, seq: asst.seq, created_at: toDto(asst).created_at });
    if (asst.status !== 'streaming') {
      sendTerminal(sse, asst, true);
    } else {
      const gen = manager.get(asst.id);
      if (gen) attachLocal(sse, gen);
      else void followRemote(sse, asst).catch((e) => {
        d.log.warn({ err: (e as Error).message }, 'followRemote failed');
        sse.send('error', { code: 'STREAM_LOST', message: '串流中斷', retryable: true, state: toDto(asst) });
        sse.end();
      });
    }
    return sse.response;
  }

  // ======================================================================= 送訊息(SSE)
  app.post('/conversations/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const body = parse(sendSchema(cfg.userMessageMaxChars), await readJson(c));
    if (isDraining()) throw new AppError(503, 'SERVER_DRAINING', '服務更新中,請稍後重試');
    const conv = await index.owned(convId, userId);

    // ---- 冪等:同一個 client_msg_id 重送(網路中斷後重試),不會產生第二則訊息、也不會重複扣點
    const existingUser = (
      await pool.query<MessageRow>(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND client_msg_id = $2`, [
        convId,
        body.client_msg_id,
      ])
    ).rows[0];
    if (existingUser) {
      const asst = (
        await pool.query<MessageRow>(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 AND seq = $2`, [
          convId,
          existingUser.seq + 1,
        ])
      ).rows[0];
      if (!asst) throw Errors.conflict('INCONSISTENT', '訊息狀態異常,請聯絡客服');
      if (asst.status === 'failed') return startRegenerate(c, userId, conv, existingUser, asst);
      return streamExisting(c, existingUser, asst);
    }

    // ---- 負載保護:這台 instance 同時生成數已滿就快速拒絕(客戶端稍後重試 / 上游改打別台)
    if (manager.activeCount >= cfg.maxActive) {
      throw new AppError(503, 'SERVER_BUSY', '系統忙碌中,請稍後再試', { retry_after: 2 });
    }

    // ---- 每個對話同一時間只允許一個進行中的回覆(鎖的值 = AI 訊息 id,reaper 用它判斷鎖是否仍屬於該訊息)
    const assistantId = randomUUID();
    const userMsgId = randomUUID();
    const token = await acquireLock(redis, lockKey(convId), cfg.lockTtlMs, assistantId).catch(() => {
      throw Errors.unavailable('系統暫時無法處理,請稍後再試');
    });
    if (!token) {
      throw Errors.conflict('GENERATION_IN_PROGRESS', 'AI 正在回覆上一則訊息,請稍候');
    }

    const holdRef = `${assistantId}#0`;
    let held = false;
    try {
      const character = await d.directory.get(conv.characterId);
      if (character.status !== 'active') throw Errors.conflict('CHARACTER_UNAVAILABLE', '這個角色目前無法聊天');

      // ---- 1) 預扣點數(不足 → 402;billing 掛了 → 503。此時還沒寫任何訊息,失敗乾淨俐落)
      // 注意「結果未知」:逾時/網路錯誤時,billing 可能已經提交了預扣,只是回應沒回來。
      // 所以只要請求「發出過」就視為可能已預扣;只有明確收到 4xx(例如 402)才能確定沒有預扣。
      // 失敗路徑會 release 這個 ref(release 是冪等的,對不存在的 ref 是 no-op)。
      held = true;
      try {
        await d.billing.post('/internal/holds', { ref: holdRef, user_id: userId, amount: character.price });
      } catch (e) {
        if (e instanceof AppError && e.status >= 400 && e.status < 500) held = false; // 明確被拒絕:確定沒有預扣
        throw e;
      }

      // ---- 2) 配號 + 寫入 user 訊息與 AI 訊息(placeholder)
      // 單一語句(CTE):一次往返、一次 commit,整體原子。
      // UPDATE conversations 會對該列加 row lock,所以同一個對話內 seq 嚴格遞增、沒有空洞。
      const ins = await pool.query<{ u: MessageRow; a: MessageRow }>(
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
        [convId, userMsgId, userId, body.content, body.client_msg_id, assistantId, character.model ?? d.provider.defaultModel, holdRef],
      );
      const rows = { user: ins.rows[0]!.u, asst: ins.rows[0]!.a };

      await d.recent.upsert(toDto(rows.user));
      await d.recent.upsert(toDto(rows.asst));

      // ---- 3) 啟動生成(背景),並把這條 HTTP 連線掛上去當訂閱者
      const messages = await buildMessages(character, convId, rows.user.seq, body.content);
      const gen = manager.create({
        assistantId,
        conversationId: convId,
        userId,
        seq: rows.asst.seq,
        holdRef,
        character,
        messages,
        createdAt: toDto(rows.asst).created_at,
      });
      const sse = new SseStream(c);
      sse.send('user_message', toDto(rows.user));
      sse.send('assistant_start', { id: assistantId, seq: rows.asst.seq, created_at: toDto(rows.asst).created_at });
      attachLocal(sse, gen);
      manager.start(gen);
      return sse.response;
    } catch (e) {
      // 還沒交給 Generation 之前出錯:釋放鎖、歸還預扣(歸還失敗會記下來由 reaper 重試,不會吞掉)
      await releaseLock(redis, lockKey(convId), token).catch(() => undefined);
      if (held) await releaseOrDefer(d, holdRef);
      if ((e as { code?: string }).code === '23505') {
        // 兩個相同 client_msg_id 的請求同時到達,另一個先寫入了:請客戶端再送一次,會走冪等分支
        throw Errors.conflict('DUPLICATE_IN_FLIGHT', '相同的訊息正在處理中,請稍後重試');
      }
      throw e;
    }
  });

  /** 重試失敗的回覆:沿用同一則 AI 訊息(同 seq),用新的預扣 ref(#attempt),歷史裡不會留下殘骸。 */
  async function startRegenerate(
    c: Ctx,
    userId: string,
    conv: { id: string; characterId: string },
    userMsg: MessageRow,
    asst: MessageRow,
  ): Promise<Response> {
    if (manager.activeCount >= cfg.maxActive) throw new AppError(503, 'SERVER_BUSY', '系統忙碌中,請稍後再試', { retry_after: 2 });
    const latest = await pool.query<{ next_seq: number }>('SELECT next_seq FROM conversations WHERE id = $1', [conv.id]);
    if (latest.rows[0]!.next_seq - 1 !== asst.seq) {
      throw Errors.conflict('RETRY_NOT_LATEST', '只能重試最新一則的回覆');
    }
    const token = await acquireLock(redis, lockKey(conv.id), cfg.lockTtlMs, asst.id).catch(() => null);
    if (!token) throw Errors.conflict('GENERATION_IN_PROGRESS', 'AI 正在回覆上一則訊息,請稍候');

    const attempt = asst.attempt + 1;
    const holdRef = `${asst.id}#${attempt}`;
    let held = false;
    try {
      // 上一次嘗試的預扣必須先歸還(同步、冪等),否則覆寫 hold_ref 後它就沒人管了
      if (asst.hold_ref) await d.billing.post('/internal/holds/release', { ref: asst.hold_ref });
      const character = await d.directory.get(conv.characterId);
      held = true; // 同上:逾時時結果未知,失敗路徑一律補償 release
      try {
        await d.billing.post('/internal/holds', { ref: holdRef, user_id: userId, amount: character.price });
      } catch (e) {
        if (e instanceof AppError && e.status >= 400 && e.status < 500) held = false;
        throw e;
      }
      const upd = await pool.query<MessageRow>(
        `UPDATE messages
            SET status = 'streaming', content = '', attempt = $2, error_code = NULL, hold_ref = $3,
                billing_state = 'held', completed_at = NULL, gen_started_at = now()
          WHERE id = $1 AND status = 'failed' RETURNING ${MSG_COLS}`,
        [asst.id, attempt, holdRef],
      );
      if (!upd.rows[0]) throw Errors.conflict('RETRY_CONFLICT', '這則回覆的狀態已改變');
      const row = upd.rows[0];
      await d.recent.upsert(toDto(row));

      const messages = await buildMessages(character, conv.id, userMsg.seq, userMsg.content);
      const gen = manager.create({
        assistantId: asst.id,
        conversationId: conv.id,
        userId,
        seq: asst.seq,
        holdRef,
        character,
        messages,
        createdAt: toDto(row).created_at,
      });
      const sse = new SseStream(c);
      sse.send('user_message', toDto(userMsg));
      sse.send('assistant_start', { id: asst.id, seq: asst.seq, created_at: toDto(row).created_at });
      attachLocal(sse, gen);
      manager.start(gen);
      return sse.response;
    } catch (e) {
      await releaseLock(redis, lockKey(conv.id), token).catch(() => undefined);
      if (held) await releaseOrDefer(d, holdRef);
      throw e;
    }
  }

  // ======================================================================= 續傳:斷線後回來接著看
  app.get('/conversations/:id/messages/:mid/stream', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const mid = parse(uuid, c.req.param('mid'));
    await index.owned(convId, userId);
    const { rows } = await pool.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE id = $1 AND conversation_id = $2 AND role = 'assistant'`,
      [mid, convId],
    );
    if (!rows[0]) throw Errors.notFound('找不到訊息');
    return streamExisting(c, null, rows[0]);
  });

  return { index };
}
