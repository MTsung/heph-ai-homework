import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { streams } from '@chat-app/shared/config';
import { tx } from '@chat-app/shared/db';
import { AppError, Errors } from '@chat-app/shared/errors';
import { enqueueEvent } from '@chat-app/shared/events';
import { SessionRepository } from '../repositories/session.repository';
import { UserRepository } from '../repositories/user.repository';
import type { LoginInput, RegisterInput, UserSearchQuery } from '../schemas';
import { dummyHash, hashPassword, verifyPassword } from './password';
import type { LoginResult, SessionService } from './session.service';

export class AuthService {
  private readonly users: UserRepository;
  private readonly sessionRepo: SessionRepository;

  constructor(
    private readonly pool: Pool,
    private readonly sessions: SessionService,
  ) {
    this.users = new UserRepository(pool);
    this.sessionRepo = new SessionRepository(pool);
  }

  async register(b: RegisterInput, ip: string): Promise<LoginResult> {
    const id = randomUUID();
    const nickname = b.nickname ?? b.username;
    const passwordHash = await hashPassword(b.password);
    try {
      await this.users.insert({ id, username: b.username, passwordHash, nickname });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Errors.conflict('USERNAME_TAKEN', '這個帳號已被使用');
      throw e;
    }
    return this.sessions.start({ id, username: b.username, nickname }, b, ip);
  }

  async login(b: LoginInput, ip: string): Promise<LoginResult> {
    const user = await this.users.findByUsername(b.username);
    const ok = await verifyPassword(b.password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', '帳號或密碼錯誤');
    return this.sessions.start(user, b, ip);
  }

  async logout(userId: string, sessionId: string): Promise<void> {
    await this.sessions.revoke(userId, sessionId);
  }

  async profile(userId: string) {
    const u = await this.users.findProfile(userId);
    if (!u) throw Errors.notFound('使用者不存在');
    return { id: u.id, username: u.username, nickname: u.nickname, created_at: u.created_at };
  }

  /**
   * 刪除帳號:驗證密碼 → 同一個 transaction 內刪除使用者 + 寫入 user.deleted 事件(outbox)。
   * 下游服務(chat、billing…)消費事件後刪除各自的資料。
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const hash = await this.users.findPasswordHash(userId);
    if (!hash || !(await verifyPassword(password, hash))) {
      throw new AppError(403, 'INVALID_CREDENTIALS', '密碼錯誤');
    }
    const session = await this.sessionRepo.findByUser(userId);
    await tx(this.pool, async (c) => {
      await new UserRepository(c).delete(userId); // sessions 由 ON DELETE CASCADE 一併刪除
      await enqueueEvent(c, streams.userEvents, 'user.deleted', { user_id: userId, at: new Date().toISOString() });
    });
    await this.sessions.notifyRevoked(userId, session?.sid ?? '');
  }

  // ---------------------------------------------------------------- 後台
  searchUsers(q: UserSearchQuery) {
    return this.users.search(q);
  }

  async getUser(id: string) {
    const u = await this.users.findWithSession(id);
    if (!u) throw Errors.notFound('使用者不存在');
    return u;
  }

  stats() {
    return this.users.stats();
  }
}
