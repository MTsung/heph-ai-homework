import { createRouter, readJson } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { bulkAccountsSchema, grantSchema, holdSchema, internalLedgerQuery, resolveSchema, userIdParam } from '../schemas';
import type { AccountService } from '../services/account.service';
import type { HoldService } from '../services/hold.service';

/** 內部(chat / booking / admin 使用) */
export function internalRoutes({ accounts, holds }: { accounts: AccountService; holds: HoldService }) {
  const r = createRouter();

  // ---- 預扣 / 結算 / 釋放(chat、booking)
  r.post('/internal/holds', async (c) => c.json(await holds.hold(parse(holdSchema, await readJson(c)))));
  r.post('/internal/holds/settle', async (c) => c.json(await holds.settle(parse(resolveSchema, await readJson(c)))));
  r.post('/internal/holds/release', async (c) => c.json(await holds.release(parse(resolveSchema, await readJson(c)))));

  // ---- 後台
  r.post('/internal/grants', async (c) => c.json(await accounts.grant(parse(grantSchema, await readJson(c)))));

  r.get('/internal/ledger', async (c) => {
    const q = parse(internalLedgerQuery, c.req.query());
    return c.json(await accounts.readLedger(q.user_id, q));
  });

  r.get('/internal/accounts/:userId', async (c) => {
    const id = parse(userIdParam, c.req.param('userId'));
    return c.json(await accounts.readBalance(id));
  });

  r.post('/internal/accounts/bulk', async (c) => {
    const b = parse(bulkAccountsSchema, await readJson(c));
    return c.json({ items: await accounts.bulkBalances(b.user_ids) });
  });

  r.get('/internal/stats', async (c) => c.json(await accounts.overview()));

  return r;
}
