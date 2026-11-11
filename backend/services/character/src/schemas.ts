import { z } from 'zod';
import type { Ctx } from '@chat-app/shared/app';
import { Errors } from '@chat-app/shared/errors';

export const upsertSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  name: z.string().min(1).max(32),
  tagline: z.string().max(100).default(''),
  avatar: z.string().min(1).max(8).default('🙂'),
  // 人設(system prompt)每次請求都要重送給模型並計費,是固定的輸入成本,所以限制長度。預設角色約 170 字
  persona: z.string().min(1).max(1000),
  greeting: z.string().min(1).max(500),
  price: z.number().int().min(0).max(1000),
  model: z.string().max(64).nullable().optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  sort_order: z.number().int().default(100),
});
export type CharacterInput = z.infer<typeof upsertSchema>;

/** 路徑上的角色 id。格式不對一律當作「角色不存在」(404),不回 400 */
export function characterIdParam(c: Ctx): string {
  const id = c.req.param('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound('角色不存在');
  return id;
}
