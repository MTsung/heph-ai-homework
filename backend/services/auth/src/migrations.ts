import type { Migration } from '../../../shared/db';
import { OUTBOX_DDL } from '../../../shared/events';

export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  nickname text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 單一裝置:user_id 是 PK,每位使用者最多只有一筆「目前有效」的 session。
-- 新登入以 UPSERT 覆蓋舊的,舊裝置的 token 因 sid 不符而失效。
CREATE TABLE sessions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sid uuid NOT NULL,
  device_id text NOT NULL,
  device_name text NOT NULL,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

${OUTBOX_DDL}
`,
  },
];
