export interface Balance {
  balance: number;
  held: number;
  available: number;
}

export function toBalance(row: { balance: string | number; held: string | number }): Balance {
  const balance = Number(row.balance);
  const held = Number(row.held);
  return { balance, held, available: balance - held };
}
