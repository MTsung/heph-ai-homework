import { clientIp, createRouter, readJson, requireUser } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { deleteAccountSchema, loginSchema, registerSchema } from '../schemas';
import type { AuthService } from '../services/auth.service';

/** 對外(經 gateway):註冊、登入、登出、個人資料、刪除帳號 */
export function authRoutes({ auth }: { auth: AuthService }) {
  const r = createRouter();

  r.post('/auth/register', async (c) => {
    const b = parse(registerSchema, await readJson(c));
    return c.json(await auth.register(b, clientIp(c)), 201);
  });

  r.post('/auth/login', async (c) => {
    const b = parse(loginSchema, await readJson(c));
    return c.json(await auth.login(b, clientIp(c)));
  });

  r.post('/auth/logout', async (c) => {
    const { userId, sessionId } = requireUser(c);
    await auth.logout(userId, sessionId);
    return c.json({ ok: true });
  });

  r.get('/me', async (c) => {
    const { userId } = requireUser(c);
    return c.json(await auth.profile(userId));
  });

  r.delete('/me', async (c) => {
    const { userId } = requireUser(c);
    const body = parse(deleteAccountSchema, await readJson(c));
    await auth.deleteAccount(userId, body.password);
    return c.json({ ok: true });
  });

  return r;
}
