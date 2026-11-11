import type { Clients } from '../clients';

type Points = { balance: number; held: number; available: number };

/** 客服操作:查使用者(含點數)、補點、強制登出、看明細 / 訂位 / 對話 */
export class SupportService {
  constructor(private readonly clients: Clients) {}

  async listUsers(q: { q?: string; offset: number }) {
    const users = await this.clients.auth.get<{ items: Array<{ id: string }> }>('/internal/users', {
      query: { q: q.q, limit: 50, offset: q.offset },
    });
    const empty: { items: Record<string, Points> } = { items: {} };
    const bal = await this.clients.billing
      .post<{ items: Record<string, Points> }>('/internal/accounts/bulk', { user_ids: users.items.map((u) => u.id) })
      .catch(() => empty);
    return { items: users.items.map((u) => ({ ...u, points: bal.items[u.id] ?? null })) };
  }

  grant(userId: string, b: { amount: number; reason: string }) {
    return this.clients.billing.post('/internal/grants', { user_id: userId, amount: b.amount, reason: `[後台] ${b.reason}` });
  }

  forceLogout(userId: string) {
    return this.clients.auth.post(`/internal/users/${userId}/logout`);
  }

  ledger(userId: string, beforeId: string | undefined) {
    return this.clients.billing.get('/internal/ledger', { query: { user_id: userId, before_id: beforeId, limit: 50 } });
  }

  bookings(userId: string) {
    return this.clients.booking.get('/internal/bookings', { query: { user_id: userId, limit: 30 } });
  }

  /** 對話列表,附上角色名稱與頭像 */
  async conversations(userId: string) {
    const [convs, chars] = await Promise.all([
      this.clients.chat.get<{ items: Array<{ character_id: string }> }>('/internal/conversations', { query: { user_id: userId } }),
      this.clients.character.get<{ items: Array<{ id: string; name: string; avatar: string }> }>('/internal/characters'),
    ]);
    const byId = new Map(chars.items.map((x) => [x.id, x]));
    return {
      items: convs.items.map((cv) => ({
        ...cv,
        character_name: byId.get(cv.character_id)?.name ?? '(已移除)',
        character_avatar: byId.get(cv.character_id)?.avatar ?? '',
      })),
    };
  }

  conversationMessages(conversationId: string, beforeSeq: string | undefined) {
    return this.clients.chat.get(`/internal/conversations/${conversationId}/messages`, {
      query: { before_seq: beforeSeq, limit: 100 },
    });
  }

  // ---------------------------------------------------------------- 角色
  listCharacters() {
    return this.clients.character.get('/internal/characters');
  }

  createCharacter(body: unknown) {
    return this.clients.character.post('/internal/characters', body);
  }

  updateCharacter(id: string, body: unknown) {
    return this.clients.character.put(`/internal/characters/${id}`, body);
  }
}
