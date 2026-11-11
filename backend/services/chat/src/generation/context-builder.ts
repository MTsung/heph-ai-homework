import type { ChatMsg } from '@chat-app/shared/llm';
import type { RecentMessagesCache } from '../cache/recent-messages.cache';
import type { CharacterInfo } from '../clients/character.client';
import type { ChatConfig } from '../config';

/** 組 LLM 上下文:system(persona)+ 最近的歷史 + 這次的使用者訊息 */
export class ContextBuilder {
  constructor(
    private readonly recent: RecentMessagesCache,
    private readonly cfg: Pick<ChatConfig, 'contextMessages' | 'contextChars' | 'contextMsgMaxChars'>,
  ) {}

  async build(character: CharacterInfo, convId: string, beforeSeq: number, userText: string): Promise<ChatMsg[]> {
    const { cfg } = this;
    const history = (await this.recent.get(convId)).filter(
      (m) => m.seq < beforeSeq && (m.role === 'user' || m.status === 'completed'),
    );
    // 成本控制(輸入端):每次請求都要把這些重送給模型並計費,所以三道上限——
    //  1. 最多 contextMessages 則  2. 總字元不超過 contextChars  3. 單則歷史超過 contextMsgMaxChars 就截斷
    // 越新的訊息越重要,所以由新往舊挑,預算用完就停;被截斷的只留開頭(結尾通常是展開的細節)。
    const picked: ChatMsg[] = [];
    let chars = userText.length;
    for (let i = history.length - 1; i >= 0 && picked.length < cfg.contextMessages; i--) {
      const m = history[i]!;
      const content =
        m.content.length > cfg.contextMsgMaxChars ? `${m.content.slice(0, cfg.contextMsgMaxChars)}…` : m.content;
      if (chars + content.length > cfg.contextChars && picked.length > 0) break;
      chars += content.length;
      picked.unshift({ role: m.role, content });
    }
    return [{ role: 'system', content: character.persona }, ...picked, { role: 'user', content: userText }];
  }
}
