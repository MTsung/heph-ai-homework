import type { Migration } from '../../../../shared/db';

export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
-- 一筆訂位需求。整個對話的狀態都存在這裡(slots / pending / plan),所以使用者可以隨時離開再回來,
-- 任何一台 instance 都能接手;記憶體裡不放任何必要的狀態。
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_request_id text,
  status text NOT NULL CHECK (status IN
    ('collecting','awaiting_confirmation','confirmed','executing','succeeded','failed','unknown','cancelled','expired')),
  slots jsonb NOT NULL DEFAULT '{}',
  pending jsonb,
  candidates jsonb,

  -- 目前的方案。使用者每改一次條件就換一份(version +1、hash 改變)
  plan jsonb,
  plan_hash text,
  plan_version int NOT NULL DEFAULT 0,
  expires_at timestamptz,

  -- 使用者確認的那一份。確認當下由 plan 複製過來(條件式 UPDATE 保證 hash 相同),之後凍結(見下方 trigger)。
  -- 送出訂位只讀這一欄。
  confirmed_plan jsonb,
  confirmed_at timestamptz,

  -- 執行狀態。exec_phase 是 write-ahead 記號:
  --   pre_submit  還沒有任何請求離開本服務,當機後重做是安全的
  --   submitting  請求「可能」已經送達對方,當機後是否重送要看管道有沒有冪等保證
  exec_phase text CHECK (exec_phase IN ('pre_submit','submitting')),
  attempt int NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  result jsonb,

  version int NOT NULL DEFAULT 0, -- 樂觀鎖:每次狀態變更 +1
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX bookings_client_request_idx ON bookings (user_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_exec_idx ON bookings (updated_at) WHERE status IN ('confirmed','executing');
CREATE INDEX bookings_plan_expiry_idx ON bookings (expires_at) WHERE status = 'awaiting_confirmation';
CREATE INDEX bookings_draft_idx ON bookings (updated_at) WHERE status = 'collecting';

-- 使用者確認過的方案不可變更:就算應用程式有 bug,資料庫也不允許改寫「已確認的內容」。
CREATE FUNCTION forbid_confirmed_plan_change() RETURNS trigger AS $$
BEGIN
  IF OLD.confirmed_plan IS NOT NULL AND NEW.confirmed_plan IS DISTINCT FROM OLD.confirmed_plan THEN
    RAISE EXCEPTION 'confirmed_plan is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bookings_confirmed_plan_immutable BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION forbid_confirmed_plan_change();

-- 對話與進度紀錄(使用者看到的「辦到哪裡」)。type: user / assistant / status
CREATE TABLE booking_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('user','assistant','status')),
  text text,
  data jsonb NOT NULL DEFAULT '{}',
  client_msg_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, id);
-- 同一則使用者訊息(client_msg_id)重送只會處理一次
CREATE UNIQUE INDEX booking_events_client_msg_idx ON booking_events (booking_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

-- 點數:每一次扣點在這裡有一列,state 記錄它和 billing 之間走到哪(同 chat 的 billing_state)。
--   holding → held ──(同一個 DB tx 內隨結果提交)──▶ settle_pending ──▶ settled
--                                                └▶ release_pending ──▶ released
-- *_pending 表示「結果已決定、還沒通知 billing」,由 reaper 重試;billing 的 settle / release 都是冪等的。
CREATE TABLE charges (
  ref text PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('turn','exec')),
  amount int NOT NULL CHECK (amount > 0),
  note text NOT NULL,
  state text NOT NULL CHECK (state IN ('holding','held','settle_pending','settled','release_pending','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_open_idx ON charges (updated_at) WHERE state NOT IN ('settled','released');
CREATE INDEX charges_booking_idx ON charges (booking_id);
`,
  },
  {
    id: '002_charge_ref',
    sql: `
-- 確認當下預扣訂位費用所用的 ref。每次「嘗試確認」都用全新的 ref(例如第一次因點數不足被拒、補點後再確認),
-- 避免重用已經結束的 ref,讓結算更新不到任何一列。執行與結算都以這個欄位為準。
ALTER TABLE bookings ADD COLUMN charge_ref text;
`,
  },
];
