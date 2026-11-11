import type { Ctx } from '@chat-app/shared/app';
import type { Logger } from '@chat-app/shared/log';
import { SseStream } from '@chat-app/shared/sse';
import type { Generation, GenEvent } from '../generation/generation';
import type { GenerationManager } from '../generation/generation-manager';
import type { GenerationStreamStore } from '../generation/stream-store';
import type { MessageRepository } from '../repositories/message.repository';
import type { SendOutcome } from '../services/message.service';
import { toDto, type MessageRow } from '../types';

/**
 * 把 AI 回覆輸出成 SSE。事件順序(對外 API 契約):
 *   user_message → assistant_start → snapshot?(續傳時)→ delta* → done | error
 *
 * 三種來源:
 *   本機進行中的生成  → 訂閱 Generation(先送 snapshot,再即時轉發)
 *   別台的生成        → 輪詢 Redis Stream 追進度
 *   已經結束的訊息    → 一次送出完整內容
 */
export class MessageStreamer {
  constructor(
    private readonly manager: GenerationManager,
    private readonly messages: MessageRepository,
    private readonly streamStore: GenerationStreamStore,
    private readonly log: Logger,
  ) {}

  /** 送訊息的回應 */
  respond(c: Ctx, outcome: SendOutcome): Response {
    if (outcome.kind === 'replay') return this.replay(c, outcome.user, outcome.assistant);
    const sse = new SseStream(c);
    sse.send('user_message', outcome.user);
    sse.send('assistant_start', outcome.assistant);
    this.attachLocal(sse, outcome.generation);
    this.manager.start(outcome.generation); // 訂閱者掛好之後才開始,才不會漏掉最前面的片段
    return sse.response;
  }

  /** 已存在的 AI 訊息:冪等重送(帶 user 訊息)或續傳(不帶) */
  replay(c: Ctx, user: MessageRow | null, asst: MessageRow): Response {
    const sse = new SseStream(c);
    if (user) sse.send('user_message', toDto(user));
    sse.send('assistant_start', { id: asst.id, seq: asst.seq, created_at: toDto(asst).created_at });
    if (asst.status !== 'streaming') {
      this.sendTerminal(sse, asst, true);
    } else {
      const gen = this.manager.get(asst.id);
      if (gen) this.attachLocal(sse, gen);
      else
        void this.followRemote(sse, asst).catch((e) => {
          this.log.warn({ err: (e as Error).message }, 'followRemote failed');
          sse.send('error', { code: 'STREAM_LOST', message: '串流中斷', retryable: true, state: toDto(asst) });
          sse.end();
        });
    }
    return sse.response;
  }

  private forward(sse: SseStream, e: GenEvent): void {
    if (e.type === 'delta') {
      sse.send('delta', { t: e.text }, e.n);
    } else if (e.type === 'done') {
      sse.send('done', { message: e.message, balance: e.balance });
      sse.end();
    } else {
      sse.send('error', { code: e.code, message: e.message, retryable: e.retryable, state: e.state });
      sse.end();
    }
  }

  /** 附著到本機進行中的生成:先送目前累積的 snapshot,之後即時轉發。 */
  private attachLocal(sse: SseStream, gen: Generation): void {
    const sub = gen.subscribe((e) => this.forward(sse, e));
    if (sub.text) sse.send('snapshot', { id: gen.p.assistantId, content: sub.text, n: sub.n });
    sse.onClose(sub.unsubscribe); // 斷線只取消訂閱,生成繼續跑
  }

  /** 生成不在這台 instance:輪詢 Redis Stream 追進度,直到結束標記或 DB 狀態已結束。 */
  private async followRemote(sse: SseStream, msg: MessageRow): Promise<void> {
    let lastId = '-';
    let text = '';
    let first = true;
    let tick = 0;
    while (!sse.isClosed) {
      const entries = await this.streamStore.readAfter(msg.id, lastId, 200).catch(() => []);
      let ended = false;
      const deltas: Array<{ n: number; t: string }> = [];
      for (const { id, fields: f } of entries) {
        lastId = id;
        if (f.end) ended = true;
        else if (f.t !== undefined) {
          text += f.t;
          deltas.push({ n: Number(f.n), t: f.t });
        }
      }
      if (first) {
        if (text) sse.send('snapshot', { id: msg.id, content: text, n: deltas.at(-1)?.n ?? 0 });
        first = false;
      } else {
        for (const x of deltas) sse.send('delta', { t: x.t }, x.n);
      }
      tick += 1;
      // 看到結束標記,或每 ~1 秒對一次 DB:訊息若已不是 streaming(完成、失敗、或原 instance 當掉後被 reaper 收掉)就收尾
      if (ended || tick % 4 === 0) {
        const cur = await this.messages.findById(msg.id);
        if (!cur) {
          sse.end();
          return;
        }
        if (cur.status !== 'streaming') {
          this.sendTerminal(sse, cur, false); // 前面已經用 snapshot/delta 送過內容,done.message 帶最終全文
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** 訊息已經是終態(完成/失敗)時的輸出:一次送出完整內容。 */
  private sendTerminal(sse: SseStream, m: MessageRow, withSnapshot: boolean): void {
    const dto = toDto(m);
    if (withSnapshot && m.content) sse.send('snapshot', { id: m.id, content: m.content, n: 0 });
    if (m.status === 'completed') sse.send('done', { message: dto, balance: null });
    else
      sse.send('error', {
        code: m.error_code ?? 'GENERATION_INTERRUPTED',
        message: '回覆中斷,請重試',
        retryable: true,
        state: dto,
      });
    sse.end();
  }
}
