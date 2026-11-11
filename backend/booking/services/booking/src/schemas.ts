import { z } from 'zod';

export const uuid = z.string().uuid();

const msgId = z.string().min(1).max(64).optional();

export const detectBody = z.object({ text: z.string().max(500) });

export const messageBody = z.object({
  text: z.string().trim().min(1, '訊息不可為空').max(500, '訊息太長(上限 500 字)'),
  client_msg_id: msgId,
});
export type MessageInput = z.infer<typeof messageBody>;

export const slotsBody = z
  .object({
    client_msg_id: msgId,
    restaurant_id: z.string().min(1).max(64).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD').optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/, '時間格式需為 HH:MM').optional(),
    party_size: z.number().int().min(1).max(50).optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        phone: z.string().max(30).optional(),
        email: z.string().email('電子郵件格式不正確').max(80).optional(),
      })
      .optional(),
    extra: z.record(z.string().max(60)).optional(),
    notes: z.string().max(200).optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== 'client_msg_id'), '至少要提供一個欄位');
export type SlotsInput = z.infer<typeof slotsBody>;

export const createBody = z.object({
  text: messageBody.shape.text,
  client_request_id: z.string().min(1).max(64).optional(),
});
export type CreateInput = z.infer<typeof createBody>;

export const confirmBody = z.object({ plan_hash: z.string().min(8).max(64) });

// ============================================================================ 列表
export const LIST_VIEWS = ['attention', 'upcoming', 'in_progress', 'history', 'active', 'all'] as const;
export type ListView = (typeof LIST_VIEWS)[number];
export const HISTORY_RESULTS = ['succeeded', 'failed', 'unknown', 'cancelled', 'expired'] as const;

export const listQuery = z.object({
  view: z.enum(LIST_VIEWS).optional(),
  // 舊參數(相容):status=active|all
  status: z.enum(['active', 'all']).optional(),
  result: z.enum(HISTORY_RESULTS).optional(),
  include_drafts: z.enum(['true', 'false']).default('false'),
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export interface ListOpts {
  view: ListView;
  limit: number;
  /** 只用於 history */
  result?: (typeof HISTORY_RESULTS)[number];
  includeDrafts?: boolean;
  before?: { at: string; id: string };
}

// ============================================================================ 內部
export const internalListQuery = z.object({ user_id: uuid, limit: z.coerce.number().int().min(1).max(100).default(30) });
