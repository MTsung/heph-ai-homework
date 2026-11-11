import { createRouter, readJson } from '@chat-app/shared/app';
import { parse } from '@chat-app/shared/errors';
import { characterIdParam, upsertSchema } from '../schemas';
import type { CharacterService } from '../services/character.service';

/** 內部(chat / admin 使用):含 persona、model 等內部欄位 */
export function internalRoutes({ characters }: { characters: CharacterService }) {
  const r = createRouter();

  r.get('/internal/characters/:id', async (c) => c.json(await characters.getInternal(characterIdParam(c))));

  r.get('/internal/characters', async (c) => c.json({ items: await characters.listAll() }));

  r.post('/internal/characters', async (c) => {
    const b = parse(upsertSchema, await readJson(c));
    return c.json(await characters.create(b), 201);
  });

  r.put('/internal/characters/:id', async (c) => {
    const id = characterIdParam(c);
    const b = parse(upsertSchema, await readJson(c));
    return c.json(await characters.update(id, b));
  });

  return r;
}
