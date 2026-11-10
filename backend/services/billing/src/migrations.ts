import type { Migration } from '../../../shared/db';

export const migrations: Migration[] = [
  {
    id: '001_init',
    // 沒有 down:初始結構不提供倒退(會清光資料表)。開發環境要重來請用 `docker compose down -v`。
    sql: `
-- 帳戶:balance 是總點數、held 是「已預扣、尚未結算」的點數,可用點數 = balance - held。
-- CHECK 約束是最後一道防線:即使應用程式有 bug,資料庫也不允許超扣。
CREATE TABLE accounts (
  user_id uuid PRIMARY KEY,
  balance bigint NOT NULL DEFAULT 0,
  held bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_nonneg CHECK (balance >= 0),
  CONSTRAINT held_nonneg CHECK (held >= 0),
  CONSTRAINT held_le_balance CHECK (held <= balance)
);

-- 預扣:ref 即冪等鍵(chat 用「AI 回覆訊息 id#第幾次嘗試」),同一個 ref 重送不會重複預扣。
CREATE TABLE holds (
  ref text PRIMARY KEY,
  user_id uuid NOT NULL,
  amount int NOT NULL CHECK (amount >= 0),
  status text NOT NULL CHECK (status IN ('held','settled','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX holds_expiry_idx ON holds (expires_at) WHERE status = 'held';
CREATE INDEX holds_user_idx ON holds (user_id);

-- 帳本:append-only,使用者與客服看到的「明細」。只在結算(charge)與入帳(grant)時寫入。
CREATE TABLE ledger (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('grant','charge')),
  amount bigint NOT NULL,
  balance_after bigint NOT NULL,
  ref_type text,
  ref_id text,
  idem_key text NOT NULL UNIQUE,
  note text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON ledger (user_id, id DESC);
`,
  },
];
