import { z } from 'zod';

/** 對外一致的錯誤格式:{ error: { code, message, ...extra } } */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): { error: Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...(this.extra ?? {}) } };
  }
}

export const Errors = {
  badRequest: (message: string, extra?: Record<string, unknown>) => new AppError(400, 'INVALID_REQUEST', message, extra),
  unauthenticated: (message = '請先登入') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = '沒有權限') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = '找不到資料') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string, extra?: Record<string, unknown>) => new AppError(409, code, message, extra),
  tooMany: (retryAfterSec: number) =>
    new AppError(429, 'RATE_LIMITED', '請求太頻繁,請稍後再試', { retry_after: retryAfterSec }),
  unavailable: (message = '服務暫時無法使用,請稍後再試', code = 'SERVICE_UNAVAILABLE') =>
    new AppError(503, code, message),
};

/** 用 zod 驗證輸入,失敗時轉成 400。 */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}:` : '';
    throw Errors.badRequest(`${where}${first?.message ?? '參數錯誤'}`);
  }
  return r.data;
}
