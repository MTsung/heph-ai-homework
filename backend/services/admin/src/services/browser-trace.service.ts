import { relative, resolve, sep } from 'node:path';
import { Errors } from '@chat-app/shared/errors';
import type { Clients } from '../clients';

interface Trace {
  manifest?: string;
  enabled?: boolean;
}

/**
 * browser-use 開發執行紀錄(僅本機後台)。檔案路徑一律從 booking 回報的 manifest 推得,
 * 並檢查不會跳出 artifactRoot,不信任 URL 參數。
 */
export class BrowserTraceService {
  constructor(
    private readonly clients: Clients,
    private readonly artifactRoot: string,
  ) {}

  async manifest(id: string): Promise<{ trace: Trace; manifest: Record<string, unknown> }> {
    const detail = await this.clients.booking.get<{ result?: { trace?: Trace } }>(`/internal/bookings/${id}`);
    const trace = detail.result?.trace;
    if (!trace?.enabled || !trace.manifest) throw Errors.notFound('此訂位沒有 browser agent 執行紀錄');
    // manifest 路徑只能是 worker 產生的 bookings/{booking-id}/{run-id}/manifest.json，不能信任 URL 參數。
    if (!new RegExp(`^bookings/${id}/[0-9a-f-]{36}/manifest\\.json$`).test(trace.manifest)) throw Errors.notFound('執行紀錄路徑無效');
    const file = resolve(this.artifactRoot, trace.manifest);
    if (relative(this.artifactRoot, file).startsWith(`..${sep}`)) throw Errors.notFound('執行紀錄路徑無效');
    const text = await Bun.file(file).text();
    if (!text) throw Errors.notFound('找不到執行紀錄');
    return { trace, manifest: JSON.parse(text) as Record<string, unknown> };
  }

  /** 回傳截圖檔(呼叫端負責組成 HTTP 回應) */
  async screenshot(id: string, sequence: number): Promise<ReturnType<typeof Bun.file>> {
    const { trace, manifest } = await this.manifest(id);
    const shots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
    const shot = shots.find(
      (v): v is { sequence: number; path: string } =>
        typeof v === 'object' &&
        v !== null &&
        (v as { sequence?: unknown }).sequence === sequence &&
        typeof (v as { path?: unknown }).path === 'string',
    );
    if (!shot || !trace.manifest) throw Errors.notFound('找不到這一張截圖');
    const file = resolve(this.artifactRoot, trace.manifest, '..', shot.path);
    const runDir = resolve(this.artifactRoot, trace.manifest, '..');
    if (!/^screenshots\/\d{4}\.png$/.test(shot.path) || relative(runDir, file).startsWith(`..${sep}`)) throw Errors.notFound('截圖路徑無效');
    const image = Bun.file(file);
    if (!(await image.exists())) throw Errors.notFound('找不到截圖檔');
    return image;
  }
}
