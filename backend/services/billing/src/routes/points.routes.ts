import { createRouter, requireUser } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { ledgerQuery } from '../schemas';
import type { AccountService } from '../services/account.service';

/** 對外(經 gateway):自己的餘額與點數明細 */
export function pointsRoutes({ accounts }: { accounts: AccountService }) {
  const r = createRouter();

  r.get('/points/balance', async (c) => c.json(await accounts.readBalance(requireUser(c).userId)));

  r.get('/points/ledger', async (c) =>
    c.json(await accounts.readLedger(requireUser(c).userId, parse(ledgerQuery, c.req.query()))),
  );

  return r;
}
