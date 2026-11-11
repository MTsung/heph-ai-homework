import jwt from 'jsonwebtoken';
import { jwtSecret, envInt } from './config';
import { Errors } from './errors';

export interface TokenClaims {
  sub: string; // user id
  sid: string; // session id;單一裝置:與 Redis/DB 中該使用者「目前有效」的 sid 比對
}

export function tokenTtlSeconds(): number {
  return envInt('JWT_TTL_SECONDS', 7 * 24 * 3600);
}

export function signToken(userId: string, sid: string): string {
  return jwt.sign({ sid }, jwtSecret(), { subject: userId, expiresIn: tokenTtlSeconds(), algorithm: 'HS256' });
}

export function verifyToken(token: string): TokenClaims {
  try {
    const p = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string') throw new Error('bad claims');
    return { sub: p.sub, sid: p.sid };
  } catch {
    throw Errors.unauthenticated('登入已失效,請重新登入');
  }
}
