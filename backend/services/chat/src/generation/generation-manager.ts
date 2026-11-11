import { LlmError } from '@chat-app/shared/llm';
import { Generation, type GenerationDeps, type GenParams } from './generation';

/** 這台 instance 上進行中的生成 */
export class GenerationManager {
  private map = new Map<string, Generation>();

  constructor(private readonly d: GenerationDeps) {}

  get activeCount(): number {
    return this.map.size;
  }

  get(messageId: string): Generation | undefined {
    return this.map.get(messageId);
  }

  create(p: GenParams): Generation {
    const g = new Generation(this.d, p);
    this.map.set(p.assistantId, g);
    this.d.metrics.active.inc();
    return g;
  }

  /** 訂閱者都掛好之後才呼叫,避免漏掉最前面的片段。 */
  start(g: Generation): void {
    void g.run().finally(() => {
      this.map.delete(g.p.assistantId);
      this.d.metrics.active.dec();
    });
  }

  abortUser(userId: string): number {
    let n = 0;
    for (const g of this.map.values()) {
      if (g.p.userId === userId) {
        g.cancel(new LlmError('帳號已刪除', 'USER_DELETED', false));
        n++;
      }
    }
    return n;
  }

  /** 優雅關閉:先等進行中的回覆自然結束,逾時才強制中止(中止的訊息會被標記失敗並釋放點數)。 */
  async drain(waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (this.map.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const g of this.map.values()) g.cancel(new LlmError('服務重啟中', 'SERVER_RESTARTING', true));
    const grace = Date.now() + 3000;
    while (this.map.size > 0 && Date.now() < grace) await new Promise((r) => setTimeout(r, 100));
  }
}
