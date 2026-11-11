# 資料庫

一個 PostgreSQL 實例,內含 5 個獨立資料庫(database-per-service),服務之間不跨庫查詢。
建立位置:`backend/docker/postgres/init.sql`;資料表由各服務啟動時自行 migration。

| 資料庫 | 所屬服務 | 主要資料表 | 用途 |
|---|---|---|---|
| auth | auth | `users`、`sessions` | 使用者帳號;`sessions` 以 user_id 為 PK,每人只有一筆有效 session(單一裝置) |
| character | character | `characters` | AI 角色資料 |
| chat | chat | `conversations`、`messages`、`pending_releases` | 對話與訊息;`pending_releases` 記錄釋放失敗的預扣,由 reaper 重試 |
| billing | billing | `accounts`、`holds`、`ledger` | 點數餘額與預扣(CHECK 約束防超扣)、冪等預扣紀錄、append-only 帳本 |
| booking | booking | `bookings`、`booking_events`、`charges` | 訂位需求與狀態、進度紀錄、點數結算狀態 |

## 資料表與欄位說明

欄位以各服務的 `db/migrations.ts` 為準(`backend/services/<服務>/src/db/`,booking 在 `backend/booking/services/booking/src/db/`)。migration 的套用與倒退見 [`OPERATIONS.md`](OPERATIONS.md) §3。
所有 `user_id` 都只是 auth 的 `users.id` 的值,不是跨庫外鍵(服務之間不跨庫查詢)。

### auth

#### `users`:使用者帳號

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 使用者 id,其他服務的 `user_id` 都指向它 |
| `username` | text UNIQUE | 登入帳號 |
| `password_hash` | text | 密碼雜湊,不存明文 |
| `nickname` | text | 顯示名稱 |
| `created_at` | timestamptz | 註冊時間 |

#### `sessions`:目前有效的登入 session(單一裝置)

`user_id` 是 PK,每人最多一筆。新登入以 UPSERT 覆蓋舊的,舊裝置 token 的 `sid` 不符而失效。`users` 刪除時以 `ON DELETE CASCADE` 一併刪除。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `user_id` | uuid PK, FK → `users.id` | 所屬使用者 |
| `sid` | uuid | session id,簽進 JWT;與 Redis 中的值比對以判斷 token 是否仍有效 |
| `device_id` | text | 用戶端提供的裝置識別 |
| `device_name` | text | 裝置名稱,顯示用(例如被擠下線時告知是哪台裝置登入) |
| `ip` | text,可為空 | 登入時的 IP |
| `created_at` | timestamptz | 本次登入時間(每次登入覆蓋時會重設) |

### character

#### `characters`:AI 角色

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 角色 id |
| `slug` | text UNIQUE | 角色的固定代稱;啟動時的種子資料以它做 `ON CONFLICT DO NOTHING` |
| `name` | text | 角色名稱 |
| `tagline` | text | 一句話簡介,預設空字串 |
| `avatar` | text | 頭像(預設為 emoji `🙂`) |
| `persona` | text | 角色設定,chat 組 prompt 時作為 system 訊息 |
| `greeting` | text | 開場白,建立新對話時寫成第一則 assistant 訊息 |
| `price` | int,≥ 0 | 每則 AI 回覆要扣的點數,預設 2;chat 以它向 billing 預扣 |
| `model` | text,可為空 | 指定使用的 LLM 模型;空值表示用系統預設 |
| `status` | text | `active` 或 `disabled`;只有 `active` 會出現在角色列表 |
| `sort_order` | int | 列表排序,數字小的在前,預設 100 |
| `created_at` / `updated_at` | timestamptz | 建立 / 最後更新時間 |

### chat

#### `conversations`:對話

一位使用者與一個角色只有一條對話(`UNIQUE (user_id, character_id)`)。索引 `(user_id, last_message_at DESC)` 用於對話列表。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 對話 id |
| `user_id` | uuid | 對話擁有者 |
| `character_id` | uuid | 對話的角色(指向 character 庫的 `characters.id`) |
| `next_seq` | int | 下一則訊息的序號。更新這一列會取得 row lock,所以同一對話內的 `seq` 嚴格遞增、沒有空洞 |
| `last_message_at` | timestamptz | 最後一則訊息時間,列表排序用 |
| `last_preview` | text | 最後一則訊息的預覽文字,列表顯示用 |
| `created_at` | timestamptz | 建立時間 |

#### `messages`:訊息

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 訊息 id |
| `conversation_id` | uuid FK → `conversations.id` | 所屬對話,對話刪除時連帶刪除 |
| `user_id` | uuid | 對話擁有者,帳號刪除時用來清資料 |
| `seq` | int | 對話內序號,`UNIQUE (conversation_id, seq)`,同時是「往上滑」keyset 分頁的索引 |
| `role` | text | `user` 或 `assistant` |
| `content` | text | 訊息內容;AI 回覆串流中為目前已產生的部分 |
| `status` | text | `completed`、`streaming`(生成中)、`failed` |
| `client_msg_id` | text,可為空 | 用戶端產生的冪等鍵,只有 user 訊息有;同一對話內唯一,重送不會重複寫入 |
| `attempt` | int | AI 回覆的第幾次嘗試,失敗重試時 +1 |
| `cost` | int | 這則回覆的點數費用 |
| `model` | text,可為空 | 回覆使用的模型 |
| `provider` | text,可為空 | 實際服務的 LLM 供應商,備援時會與主要供應商不同(migration 003) |
| `input_tokens` / `output_tokens` | int,可為空 | LLM 用量,用於成本對帳(migration 003) |
| `error_code` | text,可為空 | 失敗時的錯誤代碼 |
| `billing_state` | text | 點數狀態機:`none` → `held` → `settle_pending` → `settled`,或 `held` → `release_pending` → `released`。這一列同時扮演 outbox,確保「回覆完成」與「結算 / 釋放點數」最終一致 |
| `hold_ref` | text,可為空 | 向 billing 預扣時使用的 `ref`(`holds.ref`) |
| `created_at` | timestamptz | 訊息建立時間 |
| `gen_started_at` | timestamptz | 這一次生成(含重試)的開始時間,reaper 用來判斷孤兒生成 |
| `completed_at` | timestamptz,可為空 | 完成時間 |

#### `pending_releases`:釋放失敗的預扣

預扣之後、訊息寫入之前就失敗時,沒有 `messages` 列可以掛 `billing_state`。補償用的 release 若也失敗,就記在這裡,由 reaper 重試到成功。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `hold_ref` | text PK | 要釋放的預扣 `ref` |
| `attempts` | int | 已重試次數 |
| `created_at` | timestamptz | 記錄時間 |

### billing

#### `accounts`:點數帳戶

可用點數 = `balance - held`。三個 CHECK 約束(`balance >= 0`、`held >= 0`、`held <= balance`)是最後一道防線,即使應用程式有 bug 也不會超扣。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `user_id` | uuid PK | 帳戶擁有者 |
| `balance` | bigint | 總點數 |
| `held` | bigint | 已預扣、尚未結算的點數 |
| `created_at` / `updated_at` | timestamptz | 建立 / 最後異動時間 |

#### `holds`:預扣紀錄

`ref` 是冪等鍵,同一個 `ref` 重送不會重複預扣。chat 用「AI 回覆訊息 id#第幾次嘗試」。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ref` | text PK | 冪等鍵 |
| `user_id` | uuid | 被預扣的使用者 |
| `amount` | int,≥ 0 | 預扣點數 |
| `status` | text | `held`(預扣中)、`settled`(已結算扣款)、`released`(已釋放退回) |
| `created_at` | timestamptz | 預扣時間 |
| `expires_at` | timestamptz | 預扣到期時間;逾期仍是 `held` 的由背景工作釋放(索引 `holds_expiry_idx`) |
| `resolved_at` | timestamptz,可為空 | 結算或釋放的時間 |

#### `ledger`:帳本(append-only)

使用者與客服看到的明細,只在結算(`charge`)與入帳(`grant`)時寫入,不修改、不刪除。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | bigserial PK | 流水號,明細以 `id DESC` 做 keyset 分頁 |
| `user_id` | uuid | 帳戶擁有者 |
| `type` | text | `grant`(入帳,如註冊贈點)或 `charge`(扣點) |
| `amount` | bigint | 異動點數,入帳為正、扣點為負 |
| `balance_after` | bigint | 這筆異動之後的餘額 |
| `ref_type` | text,可為空 | 來源類型:`signup`、`grant`、`message`(chat 預設)、`booking_turn`、`booking` |
| `ref_id` | text,可為空 | 來源識別,扣點時為 `holds.ref` |
| `idem_key` | text UNIQUE | 冪等鍵,例如 `charge:{ref}`、`signup:{uid}`,重送不會重複記帳 |
| `note` | text,可為空 | 顯示給使用者的說明,如「AI 回覆」「註冊贈點」 |
| `meta` | jsonb | 呼叫端附帶的額外資訊 |
| `created_at` | timestamptz | 記帳時間 |

### booking

#### `bookings`:訂位需求

整個對話的狀態都存在這裡,使用者可以隨時離開再回來,任何一台 instance 都能接手。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | 訂位 id,同時作為對外部平台送單時的冪等鍵 |
| `user_id` | uuid | 擁有者 |
| `client_request_id` | text,可為空 | 用戶端建立訂位的冪等鍵,同一使用者內唯一 |
| `status` | text | `collecting`(蒐集條件)、`awaiting_confirmation`(等使用者確認方案)、`confirmed`、`executing`、`succeeded`、`failed`、`unknown`(結果不確定)、`cancelled`、`expired` |
| `slots` | jsonb | 已蒐集到的條件(店家、日期、時間、人數等) |
| `pending` | jsonb,可為空 | 系統目前在等使用者做什麼,以 `kind` 區分(如選店、選時段、補資料、確認方案) |
| `candidates` | jsonb,可為空 | 提供給使用者選擇的候選餐廳;使用者只能從這份清單中選 |
| `plan` | jsonb,可為空 | 目前的訂位方案,使用者每改一次條件就換一份 |
| `plan_hash` | text,可為空 | `plan` 的雜湊,確認時用來比對使用者看到的就是目前這份 |
| `plan_version` | int | 方案版本,每換一份 +1 |
| `expires_at` | timestamptz,可為空 | 方案的確認期限,逾期且仍為 `awaiting_confirmation` 的會變成 `expired` |
| `confirmed_plan` | jsonb,可為空 | 使用者確認的那一份,確認當下由 `plan` 複製。送出訂位只讀這一欄。資料庫 trigger 禁止在有值之後再修改 |
| `confirmed_at` | timestamptz,可為空 | 確認時間 |
| `charge_ref` | text,可為空 | 確認時預扣訂位費用的 `ref`,每次嘗試確認都使用新的 `ref`(migration 002) |
| `exec_phase` | text,可為空 | write-ahead 記號:`pre_submit` 尚未送出任何請求,當機後重做安全;`submitting` 請求可能已送達對方,是否重送取決於管道有無冪等保證 |
| `attempt` | int | 執行嘗試次數 |
| `lease_owner` / `lease_until` | text / timestamptz,可為空 | 執行租約,記錄哪個 instance 正在執行與到期時間,租約過期後其他 instance 可接手 |
| `result` | jsonb,可為空 | 執行結果 |
| `version` | int | 樂觀鎖,每次狀態變更 +1 |
| `created_at` / `updated_at` | timestamptz | 建立 / 最後異動時間 |
| `finished_at` | timestamptz,可為空 | 進入終態的時間 |

#### `booking_events`:對話與進度紀錄

使用者看到的「辦到哪裡」。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | bigserial PK | 事件流水號,依它排序 |
| `booking_id` | uuid FK → `bookings.id` | 所屬訂位,訂位刪除時連帶刪除 |
| `type` | text | `user`(使用者訊息)、`assistant`(AI 回覆)、`status`(進度) |
| `text` | text,可為空 | 顯示的文字 |
| `data` | jsonb | 附帶資料;assistant 訊息只記 `pending_kind`,完整待辦在 `bookings.pending` |
| `client_msg_id` | text,可為空 | 使用者訊息的冪等鍵,同一訂位內唯一,重送只處理一次 |
| `created_at` | timestamptz | 事件時間 |

#### `charges`:點數結算狀態

每一次扣點一列,`state` 記錄它與 billing 之間走到哪(與 chat 的 `billing_state` 同一套)。`*_pending` 表示結果已決定、尚未通知 billing,由 reaper 重試。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ref` | text PK | 對應 billing `holds.ref` 的冪等鍵 |
| `booking_id` | uuid FK → `bookings.id` | 所屬訂位 |
| `user_id` | uuid | 被扣點的使用者 |
| `kind` | text | `turn`(AI 理解需求一輪)或 `exec`(訂位執行) |
| `amount` | int,> 0 | 點數 |
| `note` | text | 帳本顯示的說明 |
| `state` | text | `holding` → `held` → `settle_pending` → `settled`,或 `held` → `release_pending` → `released` |
| `created_at` / `updated_at` | timestamptz | 建立 / 最後異動時間 |

### 共用資料表

#### `schema_migrations`(每個資料庫都有)

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | text PK | migration 編號,如 `001_init` |
| `applied_at` | timestamptz | 執行時間 |

#### `outbox`(目前只有 auth 庫建立)

Transactional outbox,定義在 `packages/shared/src/events.ts`。業務資料與要發出的事件在同一個 transaction 寫入,再由 relay 轉送到 Redis Stream。auth 刪除帳號時用它發出 `user.deleted`。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | bigserial PK | 事件流水號 |
| `stream` | text | 目標 Redis Stream 名稱 |
| `type` | text | 事件類型,如 `user.deleted` |
| `payload` | jsonb | 事件內容 |
| `created_at` | timestamptz | 寫入時間 |
| `published_at` | timestamptz,可為空 | 轉送成功的時間;空值表示尚未發送(部分索引 `outbox_unpublished_idx`) |

另有兩個 Redis(非資料庫):`redis-state`(session / 鎖 / 串流,不淘汰)與 `redis-cache`(快取,LRU 淘汰)。
