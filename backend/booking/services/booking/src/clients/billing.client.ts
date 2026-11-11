import type { ServiceClient } from '@chat-app/shared/client';

/**
 * billing 服務的內部 API。三個操作都以 ref 為冪等鍵,重送安全。
 * 失敗時丟 AppError:4xx 是 billing 明確拒絕(例如 402 點數不足),其餘(逾時、5xx)代表「結果未知」。
 */
export class BillingClient {
  constructor(private readonly http: ServiceClient) {}

  async hold(ref: string, userId: string, amount: number, ttlSec: number): Promise<void> {
    await this.http.post('/internal/holds', { ref, user_id: userId, amount, ttl_sec: ttlSec });
  }

  async settle(ref: string, meta: Record<string, unknown>): Promise<void> {
    await this.http.post('/internal/holds/settle', { ref, meta });
  }

  async release(ref: string): Promise<void> {
    await this.http.post('/internal/holds/release', { ref });
  }
}
