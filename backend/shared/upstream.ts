import { lookup } from 'node:dns/promises';
import type { Logger } from './log';

/**
 * 一個服務名稱背後的多個 replica(docker compose `--scale`、`deploy.replicas`、k8s headless service)。
 *
 * 為什麼需要它:Bun 的 fetch 對主機名只會連到單一 IP 並一直重用那條連線,
 * 新加的 replica 永遠分不到流量,停掉的 replica 也不會被避開。
 * 這裡自己解析 DNS,對每個 IP round-robin,並在失敗時換另一個 replica 重試。
 *
 * 注意:必須用 `dns.lookup({ all: true })`。實測 `dns.resolve4()` 在 Bun 裡會一直回傳第一次的結果
 * (replica 增減後也不會更新),這正是早期「新 replica 沒有分到流量,重啟 gateway 才平均」的原因。
 *
 * 重試規則(只在「確定沒被處理」或「重送也安全」時換 replica):
 *   - ECONNREFUSED / ENOTFOUND:連線沒建立,請求一定沒被處理 → 任何方法都可以重試。
 *   - ECONNRESET 等其他網路錯誤:請求可能已經被處理 → 只重試 GET / HEAD。
 *   - 逾時 / 主動中止:不重試(呼叫端已決定放棄,或重送會讓等待時間加倍)。
 *   - 503 且帶 `x-draining` 標頭:該 replica 正在關閉、尚未處理請求 → 任何方法都可以換一台。
 */
const REFRESH_MS = 2000;
const EJECT_MS = 5000;
const DRAIN_EJECT_MS = 20_000;
const MAX_ATTEMPTS = 3;

export class Upstream {
  private ips: string[] = [];
  private readonly ejected = new Map<string, number>();
  private rr = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly host: string;
  private readonly port: string;
  private readonly managed: boolean;

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly log?: Logger,
  ) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || (u.protocol === 'https:' ? '443' : '80');
    // 只有 http + 主機名才需要自己解析;localhost、IP、https 直接用原本的 URL
    this.managed = u.protocol === 'http:' && !/^\d+\.\d+\.\d+\.\d+$/.test(this.host) && this.host !== 'localhost';
    this.start();
  }

  private start(): void {
    if (!this.managed) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    try {
      const addrs = await lookup(this.host, { all: true, family: 4 });
      this.ips = addrs.map((a) => a.address).sort();
    } catch (e) {
      // 名稱已不存在(服務被縮到 0)→ 清掉舊的 IP,不要一直打已經不在的位址;其他暫時性錯誤保留舊的
      if ((e as { code?: string }).code === 'ENOTFOUND') this.ips = [];
      this.log?.debug({ upstream: this.name, err: (e as Error).message }, 'dns refresh failed');
    }
  }

  /** 目前解析到的 replica 數(尚未解析到時回報 1) */
  get replicas(): number {
    return Math.max(1, this.ips.length);
  }

  /** 暫時避開某個 IP(連線失敗、正在關閉) */
  eject(ip: string, ms = EJECT_MS): void {
    this.ejected.set(ip, Date.now() + ms);
  }

  private pick(tried: Set<string>): { base: string; ip?: string } {
    if (!this.managed || this.ips.length === 0) return { base: this.url.replace(/\/$/, '') };
    const now = Date.now();
    for (const [ip, until] of this.ejected) if (until <= now) this.ejected.delete(ip);
    // 優先:沒試過、沒被暫時避開的;其次:沒試過的;最後:任何一個
    let pool = this.ips.filter((ip) => !tried.has(ip) && !this.ejected.has(ip));
    if (pool.length === 0) pool = this.ips.filter((ip) => !tried.has(ip));
    if (pool.length === 0) pool = this.ips;
    const ip = pool[this.rr++ % pool.length]!;
    return { base: `http://${ip}:${this.port}`, ip };
  }

  /** `path` 含查詢字串,例如 `/conversations?x=1`。body 必須可重複讀取(字串 / ArrayBuffer),不可用串流。 */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const tried = new Set<string>();
    const maxAttempts = this.managed ? Math.min(MAX_ATTEMPTS, Math.max(1, this.ips.length)) : 1;

    for (let attempt = 1; ; attempt++) {
      const { base, ip } = this.pick(tried);
      if (ip) tried.add(ip);
      const last = attempt >= maxAttempts;

      let res: Response;
      try {
        res = await fetch(`${base}${path}`, init);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (ip && (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND')) this.eject(ip);
        if (!ip || last || !this.safeToRetry(e, method)) throw e;
        this.log?.warn({ upstream: this.name, addr: ip, code, attempt }, 'upstream failed, trying another replica');
        continue;
      }

      if (res.status === 503 && res.headers.get('x-draining') && ip) {
        this.eject(ip, DRAIN_EJECT_MS);
        if (!last) {
          await res.body?.cancel().catch(() => undefined);
          this.log?.info({ upstream: this.name, addr: ip, attempt }, 'upstream is draining, trying another replica');
          continue;
        }
      }
      return res;
    }
  }

  private safeToRetry(e: unknown, method: string): boolean {
    const err = e as { name?: string; code?: string };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return true;
    return method === 'GET' || method === 'HEAD';
  }
}
