import { z } from 'zod';

export const uuid = z.string().uuid();

export const createConversationBody = z.object({ character_id: uuid });

export const sendMessageBody = (maxChars: number) =>
  z.object({
    content: z.string().trim().min(1, '訊息不可為空').max(maxChars, `訊息最長 ${maxChars} 字`),
    client_msg_id: z.string().min(8).max(64),
  });
export type SendMessageInput = z.infer<ReturnType<typeof sendMessageBody>>;

export const historyQuery = z.object({
  before_seq: z.coerce.number().int().min(1).optional(),
  after_seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type HistoryQuery = z.infer<typeof historyQuery>;

// ---------------------------------------------------------------- 內部(admin)
export const internalConversationsQuery = z.object({
  user_id: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const internalMessagesQuery = z.object({
  before_seq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
