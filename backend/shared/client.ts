import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { internalToken } from './config';

export interface RequestOpts {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  userId?: string;
  sessionId?: string;
  requestId?: string;
  timeoutMs?: number;
}

/**
 * 服務間 HTTP 呼叫(Bun 原生 fetch,自帶 keep-alive 連線池)+ 逾時 + 簡易斷路器。
 * 斷路器:連續 5 次「網路錯誤/逾時/5xx」後開路 3 秒,期間直接快速失敗(503),
 * 避免下游掛掉時,上游請求全部卡在逾時、拖垮自己的連線與 event loop。
 */
export class ServiceClient {
  private failures = 0;
  private openUntil = 0;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly defaultTimeoutMs = 5000,
  ) {}

  async request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    if (Date.now() < this.openUntil) {
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', `${this.name} 服務暫時不可用`);
    }
    const qs = opts.query
      ? Object.entries(opts.query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const headers: Record<string, string> = {
      'x-internal-token': internalToken(),
      'x-request-id': opts.requestId ?? randomUUID(),
    };
    if (opts.userId) headers['x-user-id'] = opts.userId;
    if (opts.sessionId) headers['x-session-id'] = opts.sessionId;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (e) {
      this.recordFailure();
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', `${this.name} 服務無回應:${(e as Error).message}`);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      this.recordFailure();
      throw new AppError(503, 'UPSTREAM_UNAVAILABLE', `${this.name} 回應中斷:${(e as Error).message}`);
    }
    if (res.status >= 500) this.recordFailure();
    else this.failures = 0;

    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
    }
    if (res.status >= 400) {
      const err = (json as { error?: Record<string, unknown> } | undefined)?.error ?? {};
      const { code, message, ...extra } = err;
      throw new AppError(
        res.status,
        String(code ?? 'UPSTREAM_ERROR'),
        String(message ?? `${this.name} 回應 ${res.status}`),
        extra,
      );
    }
    return json as T;
  }

  get<T = unknown>(path: string, opts?: RequestOpts): Promise<T> {
    return this.request<T>('GET', path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOpts): Promise<T> {
    return this.request<T>('PUT', path, { ...opts, body: body ?? {} });
  }
  delete<T = unknown>(path: string, opts?: RequestOpts): Promise<T> {
    return this.request<T>('DELETE', path, opts);
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= 5) {
      this.openUntil = Date.now() + 3000;
      this.failures = 0;
    }
  }
}
