import { env } from '../../../../../shared/config';
import {
  ChannelError,
  type BookingChannel,
  type BookingOption,
  type Inspection,
  type Plan,
  type SubmitOutcome,
} from '../types';

interface Availability {
  times: string[];
  required_fields: string[];
  extra_fields?: Array<{ name: string; label: string; options?: string[] }>;
  max_party?: number;
  closed?: boolean;
}

/**
 * 合作訂位平台的 API(作業題目描述的那種:送出餐廳、時間、人數 → 成功附訂位編號 / 失敗附原因)。
 * 目前接的是模擬器。之後「很多人用」時,把餐廳的訂位管道從 web_form 換成這個,不必動其他部分。
 *
 * 和網頁表單最大的差別是:平台支援冪等鍵(Idempotency-Key)。結果不明時用同一個鍵重送,
 * 平台保證不會重複訂位 —— 所以這個管道可以安全地自動重試(見 runner.ts)。
 */
export class PlatformApiChannel implements BookingChannel {
  readonly id = 'platform_api' as const;
  readonly idempotent = true;
  readonly limited = false;

  private readonly base = env('PLATFORM_API_URL', `${env('SIM_URL', 'http://localhost:9100')}/platform/v1`).replace(/\/$/, '');
  private readonly apiKey = env('PLATFORM_API_KEY', '');

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...extra };
  }

  async inspect(option: BookingOption, date: string, party: number, signal: AbortSignal): Promise<Inspection> {
    if (option.channel !== 'platform_api') throw new ChannelError('訂位管道不符');
    let res: Response;
    try {
      res = await fetch(
        `${this.base}/restaurants/${encodeURIComponent(option.restaurantId)}/availability?date=${encodeURIComponent(date)}&party=${party}`,
        { signal, headers: this.headers() },
      );
    } catch (e) {
      throw new ChannelError(`無法連線到訂位平台:${(e as Error).message}`);
    }
    if (!res.ok) throw new ChannelError(`訂位平台回應 ${res.status}`);
    const a = (await res.json()) as Availability;
    return {
      bookable: !a.closed && a.times.length > 0,
      reason: a.closed ? '這天公休' : a.times.length === 0 ? '這天沒有可訂的時段' : undefined,
      times: a.times,
      maxParty: a.max_party,
      requiredContact: a.required_fields.filter((f): f is 'name' | 'phone' | 'email' => ['name', 'phone', 'email'].includes(f)),
      extraFields: (a.extra_fields ?? []).map((f) => ({ key: f.name, label: f.label, options: f.options })),
    };
  }

  async submit(plan: Plan, key: string, beforeSend: () => Promise<void>, signal: AbortSignal): Promise<SubmitOutcome> {
    const option = plan.target;
    if (option.channel !== 'platform_api') return { kind: 'rejected', code: 'CHANNEL_MISMATCH', message: '訂位管道不符' };
    await beforeSend();
    let res: Response;
    try {
      res = await fetch(`${this.base}/reservations`, {
        method: 'POST',
        headers: this.headers({ 'idempotency-key': key }),
        body: JSON.stringify({
          restaurant_id: option.restaurantId,
          date: plan.date,
          time: plan.time,
          party_size: plan.party_size,
          contact: plan.contact,
          extra: plan.extra,
          notes: plan.notes,
        }),
        signal,
      });
    } catch (e) {
      return { kind: 'ambiguous', reason: `送出後沒有收到回應:${(e as Error).message}` };
    }
    const body = (await res.json().catch(() => null)) as { reservation_no?: string; error?: { code?: string; message?: string } } | null;
    if ((res.status === 200 || res.status === 201) && body?.reservation_no) {
      return { kind: 'success', confirmationNo: body.reservation_no };
    }
    // 4xx(408 / 429 除外)是平台明確拒絕;5xx、逾時類回應不能確定有沒有收單
    if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) {
      return { kind: 'rejected', code: body?.error?.code ?? `HTTP_${res.status}`, message: body?.error?.message ?? '訂位平台拒絕了這筆訂位' };
    }
    return { kind: 'ambiguous', reason: `訂位平台回應 ${res.status}` };
  }
}
