import { createRouter } from '@chat-app/shared/app';
import { characterIdParam } from '../schemas';
import type { CharacterService } from '../services/character.service';

/** 對外(經 gateway):只回公開欄位 */
export function characterRoutes({ characters }: { characters: CharacterService }) {
  const r = createRouter();

  r.get('/characters', async (c) => c.json({ items: await characters.listPublic() }));

  r.get('/characters/:id', async (c) => c.json(await characters.getPublic(characterIdParam(c))));

  return r;
}
