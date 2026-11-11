import { createRouter, readJson, requireUser } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { createConversationBody, historyQuery, sendMessageBody, uuid } from '../schemas';
import type { ConversationService } from '../services/conversation.service';
import type { MessageService } from '../services/message.service';
import type { MessageStreamer } from '../streaming/message-streamer';

interface Deps {
  conversations: ConversationService;
  messages: MessageService;
  streamer: MessageStreamer;
  userMessageMaxChars: number;
}

/** 對外(經 gateway):對話、歷史訊息、送訊息(SSE)、斷線續傳(SSE) */
export function conversationRoutes({ conversations, messages, streamer, userMessageMaxChars }: Deps) {
  const r = createRouter();
  const sendBody = sendMessageBody(userMessageMaxChars);

  // ---------------------------------------------------------------- 對話
  r.get('/conversations', async (c) => {
    const { userId } = requireUser(c);
    return c.json({ items: await conversations.list(userId) });
  });

  r.post('/conversations', async (c) => {
    const { userId } = requireUser(c);
    const { character_id } = parse(createConversationBody, await readJson(c));
    const { conversation, created } = await conversations.create(userId, character_id);
    return c.json(conversation, created ? 201 : 200);
  });

  // ---------------------------------------------------------------- 歷史訊息
  r.get('/conversations/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const q = parse(historyQuery, c.req.query());
    return c.json(await messages.history(userId, convId, q));
  });

  // ---------------------------------------------------------------- 送訊息(SSE)
  r.post('/conversations/:id/messages', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const body = parse(sendBody, await readJson(c));
    const outcome = await messages.send(userId, convId, body);
    return streamer.respond(c, outcome);
  });

  // ---------------------------------------------------------------- 續傳:斷線後回來接著看(SSE)
  r.get('/conversations/:id/messages/:mid/stream', async (c) => {
    const { userId } = requireUser(c);
    const convId = parse(uuid, c.req.param('id'));
    const mid = parse(uuid, c.req.param('mid'));
    const asst = await messages.findForResume(userId, convId, mid);
    return streamer.replay(c, null, asst);
  });

  return r;
}
