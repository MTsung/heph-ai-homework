import { z } from 'zod';

const deviceSchema = {
  device_id: z.string().min(1).max(128),
  device_name: z.string().min(1).max(64),
};
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,32}$/, '帳號需為 3–32 個英數字或底線');
const passwordSchema = z.string().min(6, '密碼至少 6 碼').max(128);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  nickname: z.string().trim().min(1).max(32).optional(),
  ...deviceSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(128), ...deviceSchema });
export type LoginInput = z.infer<typeof loginSchema>;

export const deleteAccountSchema = z.object({ password: z.string().min(1) });

export const userIdParam = z.string().uuid();

export const userSearchQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type UserSearchQuery = z.infer<typeof userSearchQuery>;
