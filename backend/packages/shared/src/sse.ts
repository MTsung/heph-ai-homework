import type { Ctx } from './app';

const encoder = new TextEncoder();
const MAX_QUEUED_BYTES = 1_048_576;

/**
 * Server-Sent Events 輸出,基於標準 ReadableStream。
 *  - Bun.serve 預設 10 秒沒資料就斷線 → 對該請求呼叫 server.timeout(req, 0),並以心跳維持連線
 *  - 用戶端斷線時 Bun 會呼叫 stream 的 cancel(),在這裡觸發 onClose 讓呼叫端釋放資源
 *  - 慢速客戶端保護:佇列積壓超過 1MB 就主動斷線,避免單一連線吃光記憶體
 */
export class SseStream {
  readonly response: Response;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closeHandlers: Array<() => void> = [];

  constructor(c: Ctx, heartbeatMs = 15_000, status = 200) {
    c.env.server.timeout(c.req.raw, 0);
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (ctrl) => {
          this.controller = ctrl;
        },
        cancel: () => this.markClosed(),
      },
      { highWaterMark: 65_536, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    this.response = new Response(stream, {
      status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', // 告訴 nginx 類 proxy 不要緩衝
        'x-request-id': c.get('reqId'),
      },
    });
    this.heartbeat = setInterval(() => this.comment('hb'), heartbeatMs);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeHandlers.push(cb);
  }

  send(event: string, data: unknown, id?: string | number): boolean {
    let out = '';
    if (id !== undefined) out += `id: ${id}\n`;
    out += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return this.write(out);
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.markClosed();
    try {
      this.controller.close();
    } catch {
      /* 已被取消 */
    }
  }

  private write(text: string): boolean {
    if (this.closed) return false;
    const desired = this.controller.desiredSize;
    if (desired !== null && desired < -MAX_QUEUED_BYTES) {
      // 客戶端讀得太慢
      this.markClosed();
      try {
        this.controller.error(new Error('slow consumer'));
      } catch {
        /* ignore */
      }
      return false;
    }
    try {
      this.controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      this.markClosed();
      return false;
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
    this.closeHandlers = [];
  }
}
