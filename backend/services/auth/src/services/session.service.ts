import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { channels, keys } from '@chat-app/shared/config';
import { tx } from '@chat-app/shared/db';
import { Errors } from '@chat-app/shared/errors';
import { signToken, tokenTtlSeconds } from '@chat-app/shared/jwt';
import { SessionRepository } from '../repositories/session.repository';
import type { Device, SessionEvent, UserIdentity } from '../types';

export interface LoginResult {
  token: string;
  expires_in: number;
  user: UserIdentity;
  session: { sid: string; device_name: string };
  replaced_device: string | null;
}

/**
 * 單一裝置 session。DB 是真相來源,Redis 的 sess:{uid} 是 gateway 驗證用的快取,
 * 變更後一律 PUBLISH evt:session,讓每台 gateway 清掉本機快取並踢掉舊裝置。
 */
export class SessionService {
  private readonly sessions: SessionRepository;

  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
  ) {
    this.sessions = new SessionRepository(pool);
  }

  /**
   * 建立新 session,並讓舊裝置失效(單一裝置)。
   * 關鍵:在持有 sessions 列的 row lock 期間寫 Redis。
   * 同一位使用者的並發登入因此是序列化的,Redis 最後的值一定等於 DB 最後提交的 sid,
   * 不會出現「DB 是裝置 B、Redis 卻是裝置 A」的不一致。
   * Redis 寫入失敗就整筆登入失敗(安全性狀態寧可拒絕也不要不一致)。
   */
  async start(user: UserIdentity, device: Device, ip: string): Promise<LoginResult> {
    const sid = randomUUID();
    const prev = await tx(this.pool, async (c) => {
      const repo = new SessionRepository(c);
      const previous = (await repo.lockByUser(user.id)) ?? null;
      await repo.upsert({ userId: user.id, sid, device, ip });
      try {
        await this.redis.set(keys.session(user.id), sid, 'EX', tokenTtlSeconds());
      } catch {
        throw Errors.unavailable('登入服務暫時無法使用,請稍後再試');
      }
      return previous;
    });
    // 登入成功「一律」通知 gateway,即使沒有舊 session:
    //  - 有舊 session(replaced):切斷舊裝置上進行中的連線,並讓舊裝置立刻收到「已在其他裝置登入」
    //  - 沒有舊 session(started):只讓 gateway 清掉這位使用者的本機快取。
    //    否則登出後立刻重新登入時,gateway 還記得「這個使用者沒有有效 session」(負向快取),
    //    新 token 會被誤判為 SESSION_EXPIRED,直到快取到期。
    await this.publish({
      type: prev ? 'replaced' : 'started',
      user_id: user.id,
      old_sid: prev?.sid ?? '',
      new_sid: sid,
      new_device_name: device.device_name,
    });
    return {
      token: signToken(user.id, sid),
      expires_in: tokenTtlSeconds(),
      user: { id: user.id, username: user.username, nickname: user.nickname },
      session: { sid, device_name: device.device_name },
      replaced_device: prev?.device_name ?? null,
    };
  }

  /** 撤銷 session(登出 / 後台強制登出)。指定 onlySid 時只撤銷那一個。回傳是否真的有撤銷 */
  async revoke(userId: string, onlySid?: string): Promise<boolean> {
    const sid = await this.sessions.delete(userId, onlySid);
    if (!sid) return false;
    await this.notifyRevoked(userId, sid);
    return true;
  }

  /** session 已從 DB 移除(例如帳號刪除時隨 CASCADE 刪掉)之後:清 Redis 快取並通知 gateway */
  async notifyRevoked(userId: string, oldSid: string): Promise<void> {
    await this.redis.del(keys.session(userId)).catch(() => undefined);
    await this.publish({ type: 'revoked', user_id: userId, old_sid: oldSid });
  }

  /** gateway 在 Redis 沒有 session 快取時的回源查詢 */
  find(userId: string) {
    return this.sessions.findByUser(userId);
  }

  private async publish(ev: SessionEvent): Promise<void> {
    await this.redis.publish(channels.sessionEvents, JSON.stringify(ev)).catch(() => undefined);
  }
}
