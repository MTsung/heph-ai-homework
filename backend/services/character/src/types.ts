export interface CharacterRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  avatar: string;
  persona: string;
  greeting: string;
  price: number;
  model: string | null;
  status: 'active' | 'disabled';
  sort_order: number;
  updated_at: string;
}

/** 對一般使用者公開的欄位。persona(system prompt)屬於內部資料,不外洩。 */
export function toPublicView(c: CharacterRow) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    tagline: c.tagline,
    avatar: c.avatar,
    greeting: c.greeting,
    price: c.price,
  };
}
export type PublicCharacter = ReturnType<typeof toPublicView>;
