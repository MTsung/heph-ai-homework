import { LlmError } from './types';

/** 限制同時打到模型服務的請求數;排隊超過 waitMs 就快速失敗(load shedding),不讓請求無限堆積。 */
export class Semaphore {
  private waiters: Array<() => void> = [];
  private available: number;
  constructor(permits: number) {
    this.available = permits;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  async acquire(waitMs: number): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(onRelease);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new LlmError('模型服務忙碌中,請稍後再試', 'SERVER_BUSY', true));
      }, waitMs);
      const onRelease = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiters.push(onRelease);
    });
    return () => this.release();
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }
}
