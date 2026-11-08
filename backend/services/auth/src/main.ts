import { randomUUID, scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildApp, clientIp, onShutdown, readJson, requireUser } from '../../../shared/app';
import { channels, envInt, keys, streams } from '../../../shared/config';
import { createPool, migrate, tx, waitForDb } from '../../../shared/db';
import { AppError, Errors, parse } from '../../../shared/errors';
import { enqueueEvent, OutboxRelay } from '../../../shared/events';
import { signToken, tokenTtlSeconds } from '../../../shared/jwt';
import { createRedis } from '../../../shared/redis';
import { migrations } from './migrations';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// 查無此帳號時也做一次雜湊,避免用回應時間推測帳號是否存在
const DUMMY_HASH = hashPassword('dummy-password');

const deviceSchema = {
  device_id: z.string().min(1).max(128),
  device_name: z.string().min(1).max(64),
};
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/, '帳號需為 3–32 個英數字或底線');
const passwordSchema = z.string().min(6, '密碼至少 6 碼').max(128);

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  nickname: z.string().trim().min(1).max(32).optional(),
  ...deviceSchema,
});
const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(128), ...deviceSchema });

interface UserRow {
  id: string;
  username: string;
  nickname: string;
  password_hash: string;
  created_at: Date;
}

async function main(): Promise<void> {
  const pool = createPool('auth');
  const redis = createRedis('auth');
  const { app, log, listen } = buildApp({
    service: 'auth',
    ready: async () => {
      await pool.query('SELECT 1');
      await redis.ping();
    },
  });

  await waitForDb(pool);
  await migrate(pool, 'auth', migrations);
  const relay = new OutboxRelay(pool, redis, log);
  relay.start();

  /**
   * 建立新 session,並讓舊裝置失效(單一裝置)。
   * 關鍵:在持有 sessions 列的 row lock 期間寫 Redis。
   * 同一位使用者的並發登入因此是序列化的,Redis 最後的值一定等於 DB 最後提交的 sid,
   * 不會出現「DB 是裝置 B、Redis 卻是裝置 A」的不一致。
   * Redis 寫入失敗就整筆登入失敗(安全性狀態寧可拒絕也不要不一致)。
   */
  async function startSession(
    user: Pick<UserRow, 'id' | 'username' | 'nickname'>,
    device: { device_id: string; device_name: string },
    ip: string,
  ) {
    const sid = randomUUID();
    let previous: { sid: string; device_name: string } | null = null;
    await tx(pool, async (c) => {
      const prev = await c.query<{ sid: string; device_name: string }>(
        'SELECT sid, device_name FROM sessions WHERE user_id = $1 FOR UPDATE',
        [user.id],
      );
      previous = prev.rows[0] ?? null;
      await c.query(
        `INSERT INTO sessions (user_id, sid, device_id, device_name, ip)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
           SET sid = EXCLUDED.sid, device_id = EXCLUDED.device_id,
               device_name = EXCLUDED.device_name, ip = EXCLUDED.ip, created_at = now()`,
        [user.id, sid, device.device_id, device.device_name, ip],
      );
      try {
        await redis.set(keys.session(user.id), sid, 'EX', tokenTtlSeconds());
      } catch {
        throw Errors.unavailable('登入服務暫時無法使用,請稍後再試');
      }
    });
    const prev = previous as { sid: string; device_name: string } | null;
    // 登入成功「一律」通知 gateway,即使沒有舊 session:
    //  - 有舊 session(replaced):切斷舊裝置上進行中的連線,並讓舊裝置立刻收到「已在其他裝置登入」
    //  - 沒有舊 session(started):只讓 gateway 清掉這位使用者的本機快取。
    //    否則登出後立刻重新登入時,gateway 還記得「這個使用者沒有有效 session」(負向快取),
    //    新 token 會被誤判為 SESSION_EXPIRED,直到快取到期。
    await redis
      .publish(
        channels.sessionEvents,
        JSON.stringify({
          type: prev ? 'replaced' : 'started',
          user_id: user.id,
          old_sid: prev?.sid ?? '',
          new_sid: sid,
          new_device_name: device.device_name,
        }),
      )
      .catch(() => undefined);
    return {
      token: signToken(user.id, sid),
      expires_in: tokenTtlSeconds(),
      user: { id: user.id, username: user.username, nickname: user.nickname },
      session: { sid, device_name: device.device_name },
      replaced_device: prev?.device_name ?? null,
    };
  }

  async function revokeSession(userId: string, onlySid?: string): Promise<boolean> {
    const r = onlySid
      ? await pool.query('DELETE FROM sessions WHERE user_id = $1 AND sid = $2 RETURNING sid', [userId, onlySid])
      : await pool.query('DELETE FROM sessions WHERE user_id = $1 RETURNING sid', [userId]);
    const row = r.rows[0] as { sid: string } | undefined;
    if (!row) return false;
    await redis.del(keys.session(userId)).catch(() => undefined);
    await redis
      .publish(channels.sessionEvents, JSON.stringify({ type: 'revoked', user_id: userId, old_sid: row.sid }))
      .catch(() => undefined);
    return true;
  }

  // ---------------------------------------------------------------- 對外(經 gateway)
  app.post('/auth/register', async (c) => {
    const b = parse(registerSchema, await readJson(c));
    const id = randomUUID();
    const hash = await hashPassword(b.password);
    try {
      await pool.query('INSERT INTO users (id, username, password_hash, nickname) VALUES ($1, $2, $3, $4)', [
        id,
        b.username,
        hash,
        b.nickname ?? b.username,
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('USERNAME_TAKEN', '這個帳號已被使用');
      throw e;
    }
    const out = await startSession({ id, username: b.username, nickname: b.nickname ?? b.username }, b, clientIp(c));
    return c.json(out, 201);
  });

  app.post('/auth/login', async (c) => {
    const b = parse(loginSchema, await readJson(c));
    const { rows } = await pool.query<UserRow>(
      'SELECT id, username, nickname, password_hash, created_at FROM users WHERE username = $1',
      [b.username],
    );
    const user = rows[0];
    const ok = await verifyPassword(b.password, user?.password_hash ?? (await DUMMY_HASH));
    if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', '帳號或密碼錯誤');
    return c.json(await startSession(user, b, clientIp(c)));
  });

  app.post('/auth/logout', async (c) => {
    const { userId, sessionId } = requireUser(c);
    await revokeSession(userId, sessionId);
    return c.json({ ok: true });
  });

  app.get('/me', async (c) => {
    const { userId } = requireUser(c);
    const { rows } = await pool.query<UserRow>('SELECT id, username, nickname, created_at FROM users WHERE id = $1', [
      userId,
    ]);
    if (!rows[0]) throw Errors.notFound('使用者不存在');
    return c.json({
      id: rows[0].id,
      username: rows[0].username,
      nickname: rows[0].nickname,
      created_at: rows[0].created_at,
    });
  });

  /**
   * 刪除帳號:驗證密碼 → 同一個 transaction 內刪除使用者 + 寫入 user.deleted 事件(outbox)。
   * 下游服務(chat、billing…)消費事件後刪除各自的資料。
   */
  app.delete('/me', async (c) => {
    const { userId } = requireUser(c);
    const body = parse(z.object({ password: z.string().min(1) }), await readJson(c));
    const { rows } = await pool.query<UserRow>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !(await verifyPassword(body.password, rows[0].password_hash))) {
      throw new AppError(403, 'INVALID_CREDENTIALS', '密碼錯誤');
    }
    const sidRow = await pool.query<{ sid: string }>('SELECT sid FROM sessions WHERE user_id = $1', [userId]);
    await tx(pool, async (cl) => {
      await cl.query('DELETE FROM users WHERE id = $1', [userId]); // sessions 由 ON DELETE CASCADE 一併刪除
      await enqueueEvent(cl, streams.userEvents, 'user.deleted', { user_id: userId, at: new Date().toISOString() });
    });
    await redis.del(keys.session(userId)).catch(() => undefined);
    await redis
      .publish(
        channels.sessionEvents,
        JSON.stringify({ type: 'revoked', user_id: userId, old_sid: sidRow.rows[0]?.sid ?? '' }),
      )
      .catch(() => undefined);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- 內部(gateway / admin 使用)
  /** gateway 在 Redis 沒有 session 快取時的回源查詢(DB 是 session 的真相來源)。 */
  app.get('/internal/sessions/:userId', async (c) => {
    const { rows } = await pool.query<{ sid: string; device_name: string }>(
      'SELECT sid, device_name FROM sessions WHERE user_id = $1',
      [c.req.param('userId')],
    );
    if (!rows[0]) throw Errors.notFound('沒有有效的 session');
    return c.json({ sid: rows[0].sid, device_name: rows[0].device_name });
  });

  app.get('/internal/users', async (c) => {
    const q = parse(
      z.object({
        q: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      c.req.query(),
    );
    const like = `%${(q.q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.nickname, u.created_at,
              s.device_name, s.created_at AS session_started_at
         FROM users u LEFT JOIN sessions s ON s.user_id = u.id
        WHERE u.username ILIKE $1 OR u.nickname ILIKE $1
        ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [like, q.limit, q.offset],
    );
    return c.json({ items: rows });
  });

  app.get('/internal/users/:id', async (c) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.nickname, u.created_at, s.device_name, s.created_at AS session_started_at
         FROM users u LEFT JOIN sessions s ON s.user_id = u.id WHERE u.id = $1`,
      [parse(z.string().uuid(), c.req.param('id'))],
    );
    if (!rows[0]) throw Errors.notFound('使用者不存在');
    return c.json(rows[0]);
  });

  app.post('/internal/users/:id/logout', async (c) => {
    const revoked = await revokeSession(parse(z.string().uuid(), c.req.param('id')));
    return c.json({ revoked });
  });

  app.get('/internal/stats', async (c) => {
    const { rows } = await pool.query<{ users: string; sessions: string; users_24h: string }>(
      `SELECT (SELECT count(*) FROM users) AS users,
              (SELECT count(*) FROM sessions) AS sessions,
              (SELECT count(*) FROM users WHERE created_at > now() - interval '24 hours') AS users_24h`,
    );
    const r = rows[0]!;
    return c.json({ users: Number(r.users), active_sessions: Number(r.sessions), new_users_24h: Number(r.users_24h) });
  });

  const server = listen(envInt('PORT', 3001));
  log.info({ port: server.port }, 'auth listening');
  onShutdown(log, async () => {
    relay.stop();
    await server.stop();
    await pool.end();
    redis.disconnect();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
