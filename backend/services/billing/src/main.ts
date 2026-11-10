import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { buildApp, onShutdown, readJson, requireUser } from '../../../shared/app';
import { envInt, streams } from '../../../shared/config';
import { createPool, migrate, tx, waitForDb } from '../../../shared/db';
import { AppError, Errors, parse } from '../../../shared/errors';
import { StreamConsumer } from '../../../shared/events';
import { CacheAside, CacheStats, createRedis } from '../../../shared/redis';
import { migrations } from './migrations';

const SIGNUP_BONUS = envInt('SIGNUP_BONUS', 200);
const BALANCE_CACHE_TTL_SEC = envInt('BALANCE_CACHE_TTL_SEC', 30);
const DEFAULT_HOLD_TTL_SEC = envInt('HOLD_TTL_SEC', 600);

interface Balance {
  balance: number;
  held: number;
  available: number;
}

const holdSchema = z.object({
  ref: z.string().min(1).max(128),
  user_id: z.string().uuid(),
  amount: z.number().int().min(0).max(100000),
  ttl_sec: z.number().int().min(10).max(3600).optional(),
});
const resolveSchema = z.object({
  ref: z.string().min(1).max(128),
  meta: z.record(z.unknown()).optional(),
});
const grantSchema = z.object({
  user_id: z.string().uuid(),
  amount: z.number().int().min(1).max(10_000_000),
  reason: z.string().max(200).default('客服補點'),
  idem_key: z.string().min(1).max(128).optional(),
});

async function main(): Promise<void> {
  const pool = createPool('billing');
  const redis = createRedis('billing'); // state:事件 Stream、統計
  const cacheRedis = createRedis('billing', 'cache'); // cache:餘額顯示用快取
  const { app, log, listen } = buildApp({
    service: 'billing',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
      await cacheRedis.ping();
    },
  });
  const stats = new CacheStats(redis, 'billing');
  stats.start();
  const balanceCache = new CacheAside(cacheRedis, 'bal', stats, log);

  await waitForDb(pool);
  await migrate(pool, 'billing', migrations);

  const invalidateBalance = (userId: string) => balanceCache.del(`u:${userId}`);

  /** 建立帳戶並發放註冊點數(以 signup:{uid} 為冪等鍵)。 */
  async function ensureAccount(c: PoolClient, userId: string): Promise<void> {
    const r = await c.query(
      `INSERT INTO accounts (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, SIGNUP_BONUS],
    );
    if (r.rowCount && SIGNUP_BONUS > 0) {
      await c.query(
        `INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note)
         VALUES ($1,'grant',$2,$2,'signup',$3,$4,'註冊贈點') ON CONFLICT (idem_key) DO NOTHING`,
        [userId, SIGNUP_BONUS, userId, `signup:${userId}`],
      );
    }
  }

  async function readBalance(userId: string): Promise<Balance> {
    const b = await balanceCache.get<Balance>(`u:${userId}`, BALANCE_CACHE_TTL_SEC, async () => {
      const { rows } = await pool.query<{ balance: string; held: string }>(
        'SELECT balance, held FROM accounts WHERE user_id = $1',
        [userId],
      );
      if (rows[0]) {
        const balance = Number(rows[0].balance);
        const held = Number(rows[0].held);
        return { balance, held, available: balance - held };
      }
      await tx(pool, (c) => ensureAccount(c, userId));
      const again = await pool.query<{ balance: string; held: string }>(
        'SELECT balance, held FROM accounts WHERE user_id = $1',
        [userId],
      );
      const balance = Number(again.rows[0]!.balance);
      const held = Number(again.rows[0]!.held);
      return { balance, held, available: balance - held };
    });
    return b!;
  }

  // ======================================================================= 預扣
  /**
   * 預扣(reserve)。重點:
   *   UPDATE accounts SET held = held + $amt WHERE user_id = $1 AND balance - held >= $amt
   * 「檢查餘額」與「扣除」是同一個原子 SQL,在 row lock 下序列化,
   * 所以 N 個並發請求搶最後幾點時,不可能超扣,也不需要應用層的鎖。
   */
  // 熱路徑:整個預扣是「一條語句、一次往返、一次 commit」。
  // 單一語句本身就是原子的(含 CTE 內的多個 UPDATE/INSERT),不需要 BEGIN/COMMIT 往返。
  //   ex  :這個 ref 是否已經預扣過(冪等)
  //   upd :條件式扣除 —— 餘額夠才會更新到列;已有同 ref 的 hold 時不執行
  //   ins :只在 upd 成功時寫入 hold。用一般 INSERT(不用 ON CONFLICT),
  //        若兩個相同 ref 的請求同時到達,後者會因 PK 衝突讓「整條語句」回滾,
  //        不會出現「held 已增加、hold 卻沒寫入」的半套狀態。
  const HOLD_SQL = `
    WITH ex AS (SELECT status, amount FROM holds WHERE ref = $1),
    upd AS (
      UPDATE accounts SET held = held + $3, updated_at = now()
       WHERE user_id = $2 AND balance - held >= $3 AND NOT EXISTS (SELECT 1 FROM ex)
       RETURNING balance, held
    ),
    ins AS (
      INSERT INTO holds (ref, user_id, amount, status, expires_at)
      SELECT $1, $2, $3, 'held', now() + make_interval(secs => $4) FROM upd
      RETURNING ref
    )
    SELECT (SELECT status FROM ex) AS ex_status, (SELECT amount FROM ex) AS ex_amount,
           (SELECT balance FROM upd) AS balance, (SELECT held FROM upd) AS held,
           (SELECT count(*) FROM ins)::int AS inserted`;

  async function hold(b: z.infer<typeof holdSchema>) {
    const ttl = b.ttl_sec ?? DEFAULT_HOLD_TTL_SEC;
    let accountEnsured = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let row: { ex_status: string | null; ex_amount: number | null; balance: string | null; held: string | null; inserted: number };
      try {
        row = (await pool.query(HOLD_SQL, [b.ref, b.user_id, b.amount, ttl])).rows[0];
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
      const cur = await pool.query<{ balance: string; held: string }>(
        'SELECT balance, held FROM accounts WHERE user_id = $1',
        [b.user_id],
      );
      if (!cur.rows[0] && !accountEnsured) {
        await tx(pool, (c) => ensureAccount(c, b.user_id));
        accountEnsured = true;
        continue;
      }
      const balance = Number(cur.rows[0]?.balance ?? 0);
      const heldNow = Number(cur.rows[0]?.held ?? 0);
      if (balance - heldNow >= b.amount) continue; // 剛好有人釋放了點數,再試一次
      throw new AppError(402, 'INSUFFICIENT_POINTS', '點數不足', {
        required: b.amount,
        balance,
        available: balance - heldNow,
      });
    }
    throw Errors.unavailable('系統繁忙,請稍後再試');
  }

  // ======================================================================= 結算
  // 結算同樣是單一語句:hold 轉 settled → 扣 balance 與 held → 寫帳本,三者原子完成。
  // 只有 hold 目前是 'held' 時 h 才有列;重送(已結算)時 h 為空,整條語句不改任何東西。
  const SETTLE_SQL = `
    WITH h AS (
      UPDATE holds SET status = 'settled', resolved_at = now()
       WHERE ref = $1 AND status = 'held' RETURNING user_id, amount
    ),
    a AS (
      UPDATE accounts SET balance = balance - h.amount, held = held - h.amount, updated_at = now()
        FROM h WHERE accounts.user_id = h.user_id
      RETURNING accounts.user_id, accounts.balance
    ),
    l AS (
      INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note, meta)
      SELECT h.user_id, 'charge', -h.amount, a.balance, coalesce($4::text, 'message'), $1, 'charge:' || $1, $2, $3::jsonb
        FROM h JOIN a ON a.user_id = h.user_id WHERE h.amount > 0
      ON CONFLICT (idem_key) DO NOTHING RETURNING id
    )
    SELECT (SELECT user_id FROM h) AS user_id, (SELECT balance FROM a) AS balance`;

  async function settle(b: z.infer<typeof resolveSchema>) {
    const note = (b.meta?.note as string | undefined) ?? 'AI 回覆';
    // 帳本的 ref_type 讓呼叫端標示扣點來源(chat 不帶 → 'message';booking 帶 'booking_turn' / 'booking')
    const refType = typeof b.meta?.ref_type === 'string' ? b.meta.ref_type.slice(0, 32) : null;
    const r = await pool.query<{ user_id: string | null; balance: string | null }>(SETTLE_SQL, [
      b.ref,
      note,
      JSON.stringify(b.meta ?? {}),
      refType,
    ]);
    const row = r.rows[0]!;
    if (row.user_id) {
      await invalidateBalance(row.user_id);
      return { ok: true, already: false, balance: row.balance === null ? null : Number(row.balance) };
    }
    // h 沒有列:已經結算過(冪等重送)、已被釋放、或根本不存在
    const ex = await pool.query<{ status: string }>('SELECT status FROM holds WHERE ref = $1', [b.ref]);
    if (!ex.rows[0]) throw Errors.notFound('找不到預扣紀錄');
    if (ex.rows[0].status === 'settled') return { ok: true, already: true, balance: null };
    throw Errors.conflict('HOLD_RELEASED', '預扣已被釋放(可能已逾時),無法結算');
  }

  // ======================================================================= 釋放
  async function release(b: { ref: string }) {
    const out = await tx(pool, async (c) => {
      const h = await c.query<{ user_id: string; amount: number }>(
        `UPDATE holds SET status = 'released', resolved_at = now()
          WHERE ref = $1 AND status = 'held' RETURNING user_id, amount`,
        [b.ref],
      );
      if (h.rowCount === 0) return null; // 不存在 / 已結算 / 已釋放:冪等,視為成功
      const { user_id: userId, amount } = h.rows[0]!;
      await c.query('UPDATE accounts SET held = held - $2, updated_at = now() WHERE user_id = $1', [userId, amount]);
      return userId;
    });
    if (out) await invalidateBalance(out);
    return { ok: true, already: out === null };
  }

  // ======================================================================= 入帳
  async function grant(b: z.infer<typeof grantSchema>) {
    const idem = b.idem_key ?? `admin:${randomUUID()}`;
    const out = await tx(pool, async (c) => {
      const ex = await c.query('SELECT 1 FROM ledger WHERE idem_key = $1', [idem]);
      if (ex.rowCount) return { already: true, balance: null as number | null };
      await ensureAccount(c, b.user_id);
      const acc = await c.query<{ balance: string }>(
        `UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance`,
        [b.user_id, b.amount],
      );
      const balance = Number(acc.rows[0]!.balance);
      const ins = await c.query(
        `INSERT INTO ledger (user_id, type, amount, balance_after, ref_type, ref_id, idem_key, note)
         VALUES ($1,'grant',$2,$3,'grant',$4,$4,$5) ON CONFLICT (idem_key) DO NOTHING`,
        [b.user_id, b.amount, balance, idem, b.reason],
      );
      if (ins.rowCount === 0) throw Errors.conflict('GRANT_RACE', '重複的入帳請求');
      return { already: false, balance };
    });
    await invalidateBalance(b.user_id);
    return { ok: true, ...out };
  }

  // ======================================================================= 清理逾時預扣
  // chat 服務若在預扣後當掉,hold 不會被結算也不會被釋放;這裡定期把逾時的 hold 還給使用者。
  async function sweepExpiredHolds(): Promise<number> {
    const released = await tx(pool, async (c) => {
      const { rows } = await c.query<{ ref: string; user_id: string; amount: number }>(
        `SELECT ref, user_id, amount FROM holds
          WHERE status = 'held' AND expires_at < now()
          ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      );
      for (const h of rows) {
        await c.query(`UPDATE holds SET status = 'released', resolved_at = now() WHERE ref = $1`, [h.ref]);
        await c.query('UPDATE accounts SET held = held - $2, updated_at = now() WHERE user_id = $1', [h.user_id, h.amount]);
      }
      return rows;
    });
    for (const h of released) await invalidateBalance(h.user_id);
    if (released.length) log.warn({ count: released.length }, 'released expired holds');
    return released.length;
  }
  const sweeper = setInterval(() => void sweepExpiredHolds().catch((e) => log.warn({ err: (e as Error).message }, 'sweep failed')), 30_000);
  sweeper.unref();

  // ======================================================================= 刪除帳號事件(冪等)
  const consumer = new StreamConsumer(
    redis,
    streams.userEvents,
    'billing',
    `billing-${hostname()}`,
    async (ev) => {
      if (ev.type !== 'user.deleted') return;
      const userId = String(ev.payload.user_id);
      await tx(pool, async (c) => {
        await c.query('DELETE FROM ledger WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM holds WHERE user_id = $1', [userId]);
        await c.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
      });
      await invalidateBalance(userId);
      log.info({ userId }, 'billing data deleted for user');
    },
    log,
  );
  await consumer.start();

  // ======================================================================= 對外 API
  app.get('/points/balance', async (c) => c.json(await readBalance(requireUser(c).userId)));

  const ledgerQuery = z.object({
    before_id: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  });

  async function readLedger(userId: string, q: z.infer<typeof ledgerQuery>) {
    // keyset 分頁:WHERE id < cursor ORDER BY id DESC,走 (user_id, id DESC) 索引,不論翻到多深都是 O(limit)
    const { rows } = await pool.query(
      `SELECT id, type, amount, balance_after, ref_type, ref_id, note, meta, created_at
         FROM ledger WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`,
      [userId, q.before_id ?? null, q.limit + 1],
    );
    const hasMore = rows.length > q.limit;
    const items = (hasMore ? rows.slice(0, q.limit) : rows).map((r) => ({
      ...r,
      id: Number(r.id),
      amount: Number(r.amount),
      balance_after: Number(r.balance_after),
    }));
    return { items, next_before_id: hasMore ? items[items.length - 1]!.id : null };
  }

  app.get('/points/ledger', async (c) =>
    c.json(await readLedger(requireUser(c).userId, parse(ledgerQuery, c.req.query()))),
  );

  // ======================================================================= 內部 API
  app.post('/internal/holds', async (c) => c.json(await hold(parse(holdSchema, await readJson(c)))));
  app.post('/internal/holds/settle', async (c) => c.json(await settle(parse(resolveSchema, await readJson(c)))));
  app.post('/internal/holds/release', async (c) => c.json(await release(parse(resolveSchema, await readJson(c)))));
  app.post('/internal/grants', async (c) => c.json(await grant(parse(grantSchema, await readJson(c)))));

  app.get('/internal/ledger', async (c) => {
    const q = parse(ledgerQuery.extend({ user_id: z.string().uuid() }), c.req.query());
    return c.json(await readLedger(q.user_id, q));
  });

  app.get('/internal/accounts/:userId', async (c) => {
    const id = parse(z.string().uuid(), c.req.param('userId'));
    return c.json(await readBalance(id));
  });

  app.post('/internal/accounts/bulk', async (c) => {
    const b = parse(z.object({ user_ids: z.array(z.string().uuid()).max(200) }), await readJson(c));
    if (b.user_ids.length === 0) return c.json({ items: {} });
    const { rows } = await pool.query<{ user_id: string; balance: string; held: string }>(
      'SELECT user_id, balance, held FROM accounts WHERE user_id = ANY($1::uuid[])',
      [b.user_ids],
    );
    const items: Record<string, Balance> = {};
    for (const r of rows) {
      const balance = Number(r.balance);
      const held = Number(r.held);
      items[r.user_id] = { balance, held, available: balance - held };
    }
    return c.json({ items });
  });

  app.get('/internal/stats', async (c) => {
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM accounts) AS accounts,
              (SELECT coalesce(sum(balance),0) FROM accounts) AS total_balance,
              (SELECT coalesce(sum(held),0) FROM accounts) AS total_held,
              (SELECT count(*) FROM holds WHERE status = 'held') AS active_holds,
              (SELECT coalesce(sum(amount),0) FROM ledger WHERE type = 'grant') AS total_granted,
              (SELECT coalesce(-sum(amount),0) FROM ledger WHERE type = 'charge') AS total_charged,
              (SELECT count(*) FROM ledger WHERE type = 'charge' AND created_at > now() - interval '24 hours') AS charges_24h`,
    );
    const r = rows[0]!;
    return c.json(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])));
  });

  const server = listen(envInt('PORT', 3004));
  log.info({ port: server.port }, 'billing listening');
  onShutdown(log, async () => {
    clearInterval(sweeper);
    await consumer.stop();
    stats.stop();
    await stats.flush();
    await server.stop();
    await pool.end();
    redis.disconnect();
    cacheRedis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
