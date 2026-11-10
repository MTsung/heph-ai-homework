import type { Migration } from '../../../shared/db';

export const migrations: Migration[] = [
  {
    id: '001_init',
    // 沒有 down:初始結構不提供倒退(會清光資料表)。開發環境要重來請用 `docker compose down -v`。
    sql: `
CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  tagline text NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '🙂',
  persona text NOT NULL,
  greeting text NOT NULL,
  price int NOT NULL DEFAULT 2 CHECK (price >= 0),
  model text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`,
  },
];
