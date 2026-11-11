import { z } from 'zod';

export const uuid = z.string().uuid();

export const userListQuery = z.object({ q: z.string().max(64).optional(), offset: z.coerce.number().int().min(0).default(0) });

export const grantBody = z.object({ amount: z.number().int().min(1).max(1_000_000), reason: z.string().max(100).default('客服補點') });

export const screenSequence = z.coerce.number().int().min(1).max(1000);
