import { z } from 'zod';

export const holdSchema = z.object({
  ref: z.string().min(1).max(128),
  user_id: z.string().uuid(),
  amount: z.number().int().min(0).max(100000),
  ttl_sec: z.number().int().min(10).max(3600).optional(),
});
export type HoldInput = z.infer<typeof holdSchema>;

export const resolveSchema = z.object({
  ref: z.string().min(1).max(128),
  meta: z.record(z.unknown()).optional(),
});
export type ResolveInput = z.infer<typeof resolveSchema>;

export const grantSchema = z.object({
  user_id: z.string().uuid(),
  amount: z.number().int().min(1).max(10_000_000),
  reason: z.string().max(200).default('客服補點'),
  idem_key: z.string().min(1).max(128).optional(),
});
export type GrantInput = z.infer<typeof grantSchema>;

export const ledgerQuery = z.object({
  before_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type LedgerQuery = z.infer<typeof ledgerQuery>;

export const internalLedgerQuery = ledgerQuery.extend({ user_id: z.string().uuid() });

export const userIdParam = z.string().uuid();

export const bulkAccountsSchema = z.object({ user_ids: z.array(z.string().uuid()).max(200) });
