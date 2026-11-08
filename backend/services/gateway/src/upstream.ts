import { promises as dns } from 'node:dns';
import type { Logger } from '../../../shared/log';

/**
 * 上游服務位址。在 docker compose / k8s 裡一個服務名稱可能對應多個 replica(`--scale chat=3`),
 * 這裡每 5 秒解析一次 DNS,在所有 IP 之間 round-robin。
 * (直接讓 fetch 解析的話會連到同一個 IP,新 replica 永遠分不到流量。)
 * 解析不到(例如本機直接跑,host 是 localhost)就退回原本的 URL。
 */
export class Upstream {
  private ips: string[] = [];
  private rr = 0;
  private readonly host: string;
  private readonly port: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly log: Logger,
  ) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || '80';
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(this.host) || this.host === 'localhost') return;
    try {
      const ips = await dns.resolve4(this.host);
      if (ips.length > 0) this.ips = ips.sort();
    } catch (e) {
      this.log.debug({ upstream: this.name, err: (e as Error).message }, 'dns refresh failed');
    }
  }

  base(): string {
    if (this.ips.length === 0) return this.url;
    const ip = this.ips[this.rr++ % this.ips.length]!;
    return `http://${ip}:${this.port}`;
  }

  get replicas(): number {
    return Math.max(1, this.ips.length);
  }
}
