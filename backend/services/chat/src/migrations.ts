import type { Migration } from '../../../shared/db';

export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
-- 一位使用者與一個角色只有一條對話(陪伴型產品:同一個角色的聊天紀錄是連續的)
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  character_id uuid NOT NULL,
  -- 下一則訊息的序號。更新這一列時會取得 row lock,
  -- 因此同一個對話內的 seq 嚴格遞增、沒有空洞,不需要靠時間戳排序。
  next_seq int NOT NULL DEFAULT 1,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_preview text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, character_id)
);
CREATE INDEX conversations_user_recent_idx ON conversations (user_id, last_message_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  seq int NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','streaming','failed')),
  client_msg_id text,                       -- 用戶端產生的冪等鍵(只有 user 訊息有)
  attempt int NOT NULL DEFAULT 0,           -- AI 回覆第幾次嘗試(失敗重試時 +1)
  cost int NOT NULL DEFAULT 0,
  model text,
  error_code text,
  -- 點數狀態機:這一列同時扮演 outbox,確保「回覆完成」與「結算/釋放點數」最終一致
  billing_state text NOT NULL DEFAULT 'none'
    CHECK (billing_state IN ('none','held','settle_pending','settled','release_pending','released')),
  hold_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  gen_started_at timestamptz NOT NULL DEFAULT now(),   -- 這一次生成(含重試)的開始時間,reaper 判斷孤兒用
  completed_at timestamptz,
  UNIQUE (conversation_id, seq)             -- 同時也是「往上滑」keyset 分頁用的索引
);
CREATE UNIQUE INDEX messages_client_msg_idx ON messages (conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_user_idx ON messages (user_id);
CREATE INDEX messages_streaming_idx ON messages (gen_started_at) WHERE status = 'streaming';
CREATE INDEX messages_billing_pending_idx ON messages (completed_at) WHERE billing_state IN ('settle_pending','release_pending');
`,
  },
  {
    id: '002_pending_releases',
    sql: `
-- 預扣之後、訊息寫入之前就失敗(例如 billing 逾時、DB 寫入失敗),此時沒有 messages 列可以掛 billing_state。
-- 補償用的 release 若也失敗,就記在這裡,由 reaper 重試到成功(billing 的 release 是冪等的)。
CREATE TABLE pending_releases (
  hold_ref text PRIMARY KEY,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '003_llm_usage',
    sql: `
-- 每則 AI 回覆實際由哪個供應商服務、用了多少 token。成本控制要先能「看見」成本:
-- 備援時 model 會和主要供應商不同;token 數可以對帳單、找出異常昂貴的對話。
-- 只加可為空的欄位 = 向後相容,舊版程式照常運作(滾動更新與 rollback 安全)。
ALTER TABLE messages
  ADD COLUMN provider text,
  ADD COLUMN input_tokens int,
  ADD COLUMN output_tokens int;
`,
  },
];
