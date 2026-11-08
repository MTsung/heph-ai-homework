# Chat APP API 文件

> 所有範例回應都是對實際運行的系統呼叫後取得的(僅把 token、UUID 縮短或替換)。
> 可直接匯入的 Postman 檔:[`chat-app.postman_collection.json`](chat-app.postman_collection.json) + [`chat-app.postman_environment.json`](chat-app.postman_environment.json)(用法見[最後一節](#postman))。

## 目錄
- [通則](#通則)
- [認證與單一裝置](#認證與單一裝置-auth)
- [角色](#角色-characters)
- [對話與訊息](#對話與訊息-conversations)
- [串流協定 (SSE)](#串流協定-sse)
- [點數](#點數-points)
- [事件通道](#事件通道-events)
- [後台 API](#後台-api-admin)
- [錯誤碼總表](#錯誤碼總表)
- [Postman](#postman)

---

## 通則

| 項目 | 說明 |
|---|---|
| **Base URL** | `http://localhost:8080/v1`(gateway,唯一對外入口) |
| **格式** | 請求與回應皆為 JSON(`Content-Type: application/json`),UTF-8。串流端點回 `text/event-stream`。 |
| **認證** | `Authorization: Bearer <token>`。除了 `register`、`login` 之外都需要。 |
| **欄位命名** | `snake_case`。時間為 ISO 8601 UTC(`2026-11-08T02:15:21.231Z`)。ID 為 UUID,**點數明細的 `id` 例外,是遞增整數**。 |
| **追蹤** | 每個回應都帶 `x-request-id`;請求時帶同名標頭則沿用,回報問題時附上它。 |
| **內部端點** | `/internal/*` 不會被 gateway 轉發,對外一律 404。 |

### 錯誤格式

所有錯誤(串流開始**之前**的錯誤)都是同一個格式,HTTP 狀態碼對應錯誤類型:

```json
{ "error": { "code": "INVALID_REQUEST", "message": "content:訊息不可為空" } }
```

- 程式請依 **`code`** 判斷,`message` 是給人看的繁體中文,可能調整。
- 部分錯誤帶額外欄位(例如 `INSUFFICIENT_POINTS` 帶 `required` / `balance` / `available`;`RATE_LIMITED` 帶 `retry_after`)。
- 完整清單見[錯誤碼總表](#錯誤碼總表)。

### 限流

以「每分鐘固定視窗」計算,超過回 `429 RATE_LIMITED`,body 的 `retry_after` 是建議等待秒數。

| 範圍 | 預設上限 | 備註 |
|---|---|---|
| `register` / `login` | 30 次/分鐘/IP | |
| 一般 API | 600 次/分鐘/使用者 | |
| 送訊息 `POST .../messages` | 30 次/分鐘/使用者 | **驗證失敗的請求也會計入** |
| 事件通道 `GET /events` | 30 次/分鐘/使用者 | |

> 429 **沒有** `Retry-After` 標頭,請讀 body 的 `retry_after`。上限可由 gateway 的環境變數調整(`RL_*`)。

### 冪等與重試

- **送訊息**以 `client_msg_id` 為冪等鍵:網路中斷後用**同一個** `client_msg_id` 重送,不會多一則訊息、不會重複扣點(見[送出訊息](#post-v1conversationsidmessages-sse))。
- 其他寫入請求沒有冪等鍵,不要自動重試。

---

## 認證與單一裝置 (Auth)

**單一裝置**:每位使用者同一時間只有 **1 個有效登入**。新裝置登入會讓舊裝置立即失效:

- 舊裝置的下一個請求回 `401 SESSION_REPLACED`;
- 若舊裝置開著[事件通道](#事件通道-events),會**立刻**收到 `session_replaced` 事件,不必等到下一次操作;
- 對話紀錄存在伺服器,換裝置登入後看到同一份。

### `POST /v1/auth/register`
註冊並直接登入。**需要認證:否**。

| 欄位 | 型別 | 必填 | 限制 |
|---|---|:-:|---|
| `username` | string | ✓ | 3–32 字,英數字與底線;自動轉小寫、去頭尾空白 |
| `password` | string | ✓ | 6–128 字 |
| `nickname` | string | | 1–32 字;省略時等於 `username` |
| `device_id` | string | ✓ | 1–128 字,裝置的固定識別 |
| `device_name` | string | ✓ | 1–64 字,顯示用(例如「MacBook」) |

**`201 Created`**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "expires_in": 604800,
  "user": { "id": "c65f351c-1b91-47d9-81aa-deded7f009a5", "username": "doc_mw779re9", "nickname": "文件" },
  "session": { "sid": "fe923200-1478-4fc4-a671-411ddf894c97", "device_name": "MacBook" },
  "replaced_device": null
}
```
`expires_in` 單位為秒(7 天)。註冊會贈送 **200 點**(寫入點數明細)。

| 狀態 | `code` | 時機 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 欄位格式不符,例如 `username:帳號需為 3–32 個英數字或底線` |
| 409 | `USERNAME_TAKEN` | 帳號已被使用 |
| 429 | `RATE_LIMITED` | |
| 503 | `SERVICE_UNAVAILABLE` | Redis 暫時不可用(登入為 fail-closed,寧可拒絕也不留下不一致的 session) |

### `POST /v1/auth/login`
登入。若這位使用者已有別的裝置在線,**會把它踢掉**。**需要認證:否**。

| 欄位 | 型別 | 必填 | 限制 |
|---|---|:-:|---|
| `username` | string | ✓ | 同註冊 |
| `password` | string | ✓ | 1–128 字 |
| `device_id` | string | ✓ | 1–128 字 |
| `device_name` | string | ✓ | 1–64 字 |

**`200 OK`** 格式同註冊。`replaced_device` 是被踢掉的裝置名稱(沒有則為 `null`):
```json
{ "token": "eyJ…", "expires_in": 604800,
  "user": { "id": "c65f…", "username": "doc_mw779re9", "nickname": "文件" },
  "session": { "sid": "345ddd84-d8f9-4b1b-a53d-6147abdf3d13", "device_name": "iPad" },
  "replaced_device": "MacBook" }
```

| 狀態 | `code` | 時機 |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | 帳號或密碼錯誤(兩者不區分,避免洩漏帳號是否存在) |
| 400 / 429 / 503 | | 同註冊 |

### `POST /v1/auth/logout`
登出目前的裝置。**需要認證:是**。無 body。

**`200 OK`** `{ "ok": true }`。之後同一個 token 回 `401 SESSION_EXPIRED`。

### `GET /v1/me`
**需要認證:是**。

**`200 OK`**
```json
{ "id": "c65f351c-…", "username": "doc_mw779re9", "nickname": "文件", "created_at": "2026-11-08T02:15:20.974Z" }
```

### `DELETE /v1/me`
**永久刪除帳號**。需要認證:是。**這個 DELETE 帶有 body。**

| 欄位 | 型別 | 必填 | 說明 |
|---|---|:-:|---|
| `password` | string | ✓ | 目前密碼,二次確認 |

**`200 OK`** `{ "ok": true }`

帳號資料立即刪除;對話、訊息、點數明細由事件非同步清除(至少一次投遞,消費端冪等)。刪除後原 token 失效,也無法再用原帳密登入。

| 狀態 | `code` | 時機 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 缺 `password`(`password:Required`) |
| 403 | `INVALID_CREDENTIALS` | 密碼錯誤 |

### 認證失敗的三種 401

客戶端應依 `code` 區分,**三者都應該回到登入畫面**,但提示不同:

| `code` | 意義 | 建議提示 |
|---|---|---|
| `UNAUTHENTICATED` | 沒帶 token、token 格式或簽章不對、已過期 | 「請先登入」 |
| `SESSION_REPLACED` | token 有效,但這位使用者已在**另一台**裝置登入 | 「你的帳號已在其他裝置登入」 |
| `SESSION_EXPIRED` | 該 session 已被登出、被後台強制登出,或帳號已刪除 | 「登入已失效,請重新登入」 |

---

## 角色 (Characters)

### `GET /v1/characters`
列出所有**上架中**的角色(依排序)。

**`200 OK`**
```json
{
  "items": [
    {
      "id": "00d94a49-22dc-4f54-ade1-a187d997f3cc",
      "slug": "xi",
      "name": "小曦",
      "tagline": "溫柔的傾聽者,陪你說說心裡話",
      "avatar": "🌅",
      "greeting": "嗨,我是小曦。今天過得怎麼樣?想聊什麼都可以,我在這裡聽你說。",
      "price": 2
    }
  ]
}
```

| 欄位 | 說明 |
|---|---|
| `price` | 該角色**每則成功回覆**扣的點數 |
| `greeting` | 開場白;建立對話時會成為第一則訊息(`seq = 1`) |

角色的人設(system prompt)是內部資料,**不會**出現在任何對外回應。伺服器端快取約 10 分鐘,後台修改後會立即失效。

### `GET /v1/characters/{id}`
單一角色,格式同上。不存在、已下架或 `id` 不是 UUID → `404 NOT_FOUND`(`角色不存在`)。

---

## 對話與訊息 (Conversations)

**模型**:一位使用者與一個角色只有**一條連續對話**。

**`seq`(序號)**:每個對話內嚴格遞增、**沒有空洞**(1, 2, 3…)。客戶端請**以 `seq` 排序與去重**,不要用時間戳。它也是分頁的游標。

### `GET /v1/conversations`
目前使用者的所有對話(依最後訊息時間,新→舊)。

**`200 OK`**
```json
{
  "items": [
    {
      "id": "5c847329-5533-4ca3-84d4-ad55f1596b24",
      "character_id": "00d94a49-22dc-4f54-ade1-a187d997f3cc",
      "last_message_at": "2026-11-08T02:15:21.231Z",
      "last_preview": "嗨,我是小曦。今天過得怎麼樣?想聊什麼都可以,我在這裡聽你說。",
      "latest_seq": 1,
      "created_at": "2026-11-08T02:15:21.231Z"
    }
  ]
}
```

### `POST /v1/conversations`
開啟與某角色的對話。**已存在就直接回傳**(冪等),不會建立第二條。

| 欄位 | 型別 | 必填 |
|---|---|:-:|
| `character_id` | string(UUID) | ✓ |

- **`201 Created`**:新建立(含開場白為 `seq = 1` 的第一則訊息),body 格式同上方單筆對話。
- **`200 OK`**:已存在。
- `404 NOT_FOUND`:角色不存在或已下架。

### `GET /v1/conversations/{id}/messages`
讀取歷史訊息。**非本人的對話一律 `404 NOT_FOUND`**(不洩漏對話是否存在)。

三種讀法,`items` 一律依 `seq` **由舊到新**:

| 參數 | 用途 | 行為 |
|---|---|---|
| (無) | 開啟對話 | 最新一頁(優先讀 Redis 快取) |
| `before_seq` | **往上滑** | `seq < before_seq` 的最近一頁 |
| `after_seq` | **補同步**(另一台裝置發過訊息、重新連線後) | `seq > after_seq`,由舊到新 |
| `limit` | 每頁筆數 | 1–100,預設 30 |

> 同時給 `before_seq` 與 `after_seq` 時,`after_seq` 優先。

**往上滑的標準做法**:取目前畫面上最舊那則的 `seq` 當 `before_seq`,直到 `has_more_before` 為 `false`。因為游標是 `seq`(不是頁碼),翻頁期間有新訊息進來也**不會重複或漏掉**,而且翻到多深成本都一樣。

**`200 OK`**
```json
{
  "items": [
    {
      "id": "6b532ad9-b5f9-4b6f-bafa-8de02dcef89a",
      "conversation_id": "5c847329-5533-4ca3-84d4-ad55f1596b24",
      "seq": 1,
      "role": "assistant",
      "content": "嗨,我是小曦。今天過得怎麼樣?想聊什麼都可以,我在這裡聽你說。",
      "status": "completed",
      "error_code": null,
      "client_msg_id": null,
      "created_at": "2026-11-08T02:15:21.231Z"
    }
  ],
  "has_more_before": false,
  "has_more_after": false
}
```

#### 訊息物件

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | UUID | |
| `conversation_id` | UUID | |
| `seq` | int | 對話內序號 |
| `role` | `"user"` \| `"assistant"` | |
| `content` | string | AI 回覆**進行中**時是空字串(內容走[串流](#串流協定-sse)) |
| `status` | `"completed"` \| `"streaming"` \| `"failed"` | `streaming`:仍在生成,請用[續傳端點](#get-v1conversationsidmessagesmidstream-sse)接回;`failed`:失敗(`content` 可能含已產生的部分文字),可重試 |
| `error_code` | string \| null | `failed` 時的原因,見[串流錯誤碼](#error-事件的-code) |
| `client_msg_id` | string \| null | 只有 `user` 訊息有 |
| `created_at` | string | |

| 狀態 | `code` | 時機 |
|---|---|---|
| 400 | `INVALID_REQUEST` | `limit` 超出 1–100(`limit:Number must be less than or equal to 100`)、`id` 不是 UUID(`Invalid uuid`) |
| 404 | `NOT_FOUND` | 對話不存在或不是你的 |

### `POST /v1/conversations/{id}/messages` (SSE)
**送出一則訊息,並以串流接收 AI 的回覆。**

| 欄位 | 型別 | 必填 | 限制 |
|---|---|:-:|---|
| `content` | string | ✓ | 1–500 字(去頭尾空白後)。上限是成本控制的一環:每次請求都要把訊息與歷史重送給模型並計費 |
| `client_msg_id` | string | ✓ | 8–64 字;**由客戶端產生(建議 UUID)**,是冪等鍵 |

**成功**:`200`,`Content-Type: text/event-stream`,事件格式見[串流協定](#串流協定-sse)。

**串流開始之前**的失敗是一般的 JSON 錯誤(此時**尚未寫入任何訊息、也沒有扣點**):

| 狀態 | `code` | 時機 | 客戶端建議 |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | 內容為空、過長、`client_msg_id` 太短 | |
| 402 | `INSUFFICIENT_POINTS` | 可用點數不足。body 帶 `required`、`balance`、`available` | 提示儲值;把文字還給輸入框 |
| 404 | `NOT_FOUND` | 對話不存在或不是你的 | |
| 409 | `GENERATION_IN_PROGRESS` | 這個對話已有一則回覆在進行中(一個對話同時只允許一則) | 等它結束,或用[續傳端點](#get-v1conversationsidmessagesmidstream-sse)接上 |
| 409 | `CHARACTER_UNAVAILABLE` | 角色已下架 | |
| 409 | `DUPLICATE_IN_FLIGHT` | 兩個相同 `client_msg_id` 的請求同時到達 | 稍後重送,會走冪等分支 |
| 409 | `RETRY_NOT_LATEST` | 重試的不是最新一則回覆 | |
| 429 | `RATE_LIMITED` | 見[限流](#限流) | 讀 `retry_after` |
| 503 | `SERVER_BUSY` / `SERVER_DRAINING` / `UPSTREAM_UNAVAILABLE` | 系統忙碌、滾動更新中、點數服務暫時不可用 | 稍後以同一個 `client_msg_id` 重試 |

**點數**:送出前先**預扣**該角色的 `price`;回覆**成功**才結算扣點,**失敗不扣**(預扣歸還)。見 [點數](#點數-points)。

#### 冪等與重試(重要)

| 情境 | 用同一個 `client_msg_id` 重送會…… |
|---|---|
| 上一次的回覆**進行中** | 接到同一條串流(先收 `snapshot`,再續收 `delta`) |
| 上一次的回覆**已完成** | 一次回放:`user_message` → `assistant_start` → `snapshot` → `done`(`balance` 為 `null`),**不會再扣點** |
| 上一次的回覆**失敗** | **沿用同一則 AI 訊息(相同 `seq`、`id`)重新生成**,用新的預扣;歷史裡不留殘骸。只能重試最新一則 |

所以客戶端「重試」按鈕的正確做法是:**用原本那則訊息的 `client_msg_id` 再送一次**,而不是產生新的。

### `GET /v1/conversations/{id}/messages/{mid}/stream` (SSE)
**續傳**:接回一則 AI 回覆的串流。用於斷線、App 重開、切換對話後回來。`mid` 是 AI 訊息的 `id`(取自 `assistant_start` 事件或歷史裡 `status = streaming` 的那則)。

回應依該訊息的狀態:

| 訊息狀態 | 串流內容 |
|---|---|
| `streaming` | `assistant_start` → `snapshot`(目前累積的全文)→ 之後的 `delta`… → `done` / `error` |
| `completed` | `assistant_start` → `snapshot`(全文)→ `done`(`balance: null`) |
| `failed` | `assistant_start` → `snapshot`(部分文字)→ `error` |

```
event: assistant_start
data: {"id":"c542e5ce-…","seq":3,"created_at":"2026-11-08T02:15:21.351Z"}

event: snapshot
data: {"id":"c542e5ce-…","content":"嗨,見到你真好。今天心情怎麼樣?","n":0}

event: done
data: {"message":{…},"balance":null}
```

**生成與連線是脫鉤的**:使用者斷線、關掉 App,AI 回覆仍會在伺服器端完成並存檔、結算。重新連上時走這個端點(或直接讀歷史)即可。

`404 NOT_FOUND`:訊息不存在、不屬於這個對話,或不是 AI 訊息。

---

## 串流協定 (SSE)

兩個串流端點([送訊息](#post-v1conversationsidmessages-sse)、[續傳](#get-v1conversationsidmessagesmidstream-sse))使用同一套事件。

### 傳輸

- 標頭:`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`。
- 以空行分隔事件;`id:` 行出現在 `delta` 上。
- 每 ~15 秒一則**註解**心跳(`: hb`),維持連線;解析時請忽略以 `:` 開頭的行。
- **網路封包的切分點是任意的**:可能切在事件中間,甚至切在一個中文字的 UTF-8 位元組中間。請用串流解碼(例如 Dart 的 `utf8.decoder.bind`、JS 的 `TextDecoder({stream:true})`)並累積到空行才算一個事件。
- 串流開始後,HTTP 狀態碼已是 200,**錯誤只能用 `error` 事件回報**。

### 事件

| 事件 | 資料 | 何時 |
|---|---|---|
| `user_message` | [訊息物件](#訊息物件)(`role: "user"`) | 訊息已寫入;帶有伺服器配的 `seq` |
| `assistant_start` | `{ id, seq, created_at }` | AI 訊息已建立(`status: streaming`);`id` 供續傳使用 |
| `delta` | `{ "t": "文字片段" }`,`id:` 為遞增序號 `n` | 每個片段 |
| `snapshot` | `{ id, content, n }` | **續傳或重送時**:目前已累積的**完整**內容。收到後請**直接取代**畫面上的內容,不要附加 |
| `done` | `{ message, balance }` | 完成。`message` 含最終全文;`balance` 是結算後餘額(重送/續傳時為 `null`) |
| `error` | `{ code, message, retryable, state }` | 失敗。`state` 是該 AI 訊息目前的樣子(含已產生的部分文字);**不扣點** |

`done` 與 `error` 是**終止事件**,之後伺服器關閉連線。

#### 一次正常的交換

```
event: user_message
data: {"id":"2aaf70d1-…","conversation_id":"5c847329-…","seq":2,"role":"user","content":"你好","status":"completed","error_code":null,"client_msg_id":"c41b60c9-…","created_at":"…"}

event: assistant_start
data: {"id":"c542e5ce-3f1b-4189-84c2-ba371ef29fb2","seq":3,"created_at":"2026-11-08T02:15:21.351Z"}

id: 1
event: delta
data: {"t":"嗨,"}

id: 2
event: delta
data: {"t":"見"}

… (更多 delta) …

event: done
data: {"message":{"id":"c542e5ce-…","conversation_id":"5c847329-…","seq":3,"role":"assistant","content":"嗨,見到你真好。今天心情怎麼樣?","status":"completed","error_code":null,"created_at":"…"},"balance":198}
```

#### 一次失敗

```
event: assistant_start
data: {"id":"ed6155b2-…","seq":5,"created_at":"…"}

event: error
data: {"code":"LLM_ERROR","message":"模型暫時無法回應,請稍後再試","retryable":true,"state":{"id":"ed6155b2-…","seq":5,"role":"assistant","content":"嗯嗯,你說「測試」,我","status":"failed","error_code":"LLM_ERROR","created_at":"…"}}
```

#### `error` 事件的 `code`

| `code` | 意義 | `retryable` |
|---|---|:-:|
| `LLM_ERROR` | 模型回應錯誤 | ✓ |
| `LLM_RATE_LIMITED` | 模型供應商限流 | ✓ |
| `LLM_UNREACHABLE` | 連不上模型服務 | ✓ |
| `FIRST_TOKEN_TIMEOUT` | 模型在逾時內沒有產生第一個字(整體上限 25 秒;單一供應商 8 秒就會換下一家) | ✓ |
| `GENERATION_TIMEOUT` | 單則回覆超過 120 秒 | ✓ |
| `EMPTY_REPLY` | 模型沒有產生內容 | ✓ |
| `SERVER_BUSY` | 模型呼叫排隊逾時(系統忙碌) | ✓ |
| `SERVER_RESTARTING` | 伺服器滾動更新,回覆被中止 | ✓ |
| `GENERATION_INTERRUPTED` | 處理這則回覆的伺服器中途離線,或回覆已被後端判定中斷 | ✓ |
| `LLM_UNAVAILABLE` | **所有模型供應商都無法服務**(備援也失敗,或都在斷路冷卻中)。訊息為「目前系統有問題,請稍後再試」。**不扣點** | ✓ |
| `LLM_BLOCKED` | 內容被模型的安全機制擋下。**不換供應商**、不計入故障。重試同樣內容仍會被擋,客戶端不應顯示重試按鈕。**不扣點** | ✗ |
| `STREAM_LOST` | 續傳時追不到進度 | ✓ |
| `USER_DELETED` | 帳號已刪除 | ✗ |

### 客戶端處理建議

1. **以 `seq` 為準**:`user_message` 會給樂觀顯示的本地訊息補上 `seq`;`assistant_start` 建立 AI 泡泡。
2. **`delta` 附加,`snapshot` 取代**。
3. **串流提前結束**(沒收到 `done` / `error`):網路中斷。回覆在伺服器仍會完成 → 以退避重試呼叫[續傳端點](#get-v1conversationsidmessagesmidstream-sse)(建議 0.5、1、2、4 秒)。
4. 收到 `done` 用 `balance` 更新畫面上的點數;稍後再 `GET /points/balance` 校正(可能有其他進行中的預扣)。
5. 失敗後的重試:用**同一個 `client_msg_id`** 再送。

---

## 點數 (Points)

**兩階段扣點**:送訊息前**預扣**(`held`),回覆成功**結算**(`balance` 減少、寫入明細),失敗則**釋放**。

```
可用點數 (available) = 總點數 (balance) − 預扣中 (held)
```

預扣中的點數不能再花,所以不會超扣。

### `GET /v1/points/balance`
**`200 OK`**
```json
{ "balance": 198, "held": 0, "available": 198 }
```
此值有最多 30 秒的伺服器端快取(僅供顯示),**可用點數是否足夠以送訊息時的檢查為準**。

### `GET /v1/points/ledger`
點數明細(使用者與客服看到的是**同一份**帳本)。新→舊,以 `id` 為游標。

| 參數 | 說明 |
|---|---|
| `before_id` | 取 `id < before_id` 的下一頁 |
| `limit` | 1–100,預設 30 |

**`200 OK`**
```json
{
  "items": [
    {
      "id": 32,
      "type": "charge",
      "amount": -2,
      "balance_after": 198,
      "ref_type": "message",
      "ref_id": "c542e5ce-3f1b-4189-84c2-ba371ef29fb2#0",
      "note": "與小曦的對話",
      "meta": {
        "seq": 3,
        "note": "與小曦的對話",
        "message_id": "c542e5ce-3f1b-4189-84c2-ba371ef29fb2",
        "conversation_id": "5c847329-5533-4ca3-84d4-ad55f1596b24"
      },
      "created_at": "2026-11-08T02:15:21.653Z"
    },
    {
      "id": 31, "type": "grant", "amount": 200, "balance_after": 200,
      "ref_type": "signup", "ref_id": "c65f351c-…", "note": "註冊贈點", "meta": {},
      "created_at": "2026-11-08T02:15:21.344Z"
    }
  ],
  "next_before_id": null
}
```

| 欄位 | 說明 |
|---|---|
| `type` | `charge`(扣點,`amount` 為負)、`grant`(入帳,`amount` 為正) |
| `ref_type` / `ref_id` | 來源:`message`(`ref_id` 是 `{AI訊息id}#{第幾次嘗試}`)、`signup`、`grant`(後台補點) |
| `balance_after` | 這筆之後的總點數 |
| `meta.message_id` / `conversation_id` / `seq` | 可追溯到是哪一則回覆 |
| `next_before_id` | 還有下一頁時為最後一筆的 `id`,否則 `null` |

**只有成功的回覆會出現在明細**;失敗的回覆沒有扣點,所以沒有紀錄。

---

## 事件通道 (Events)

### `GET /v1/events` (SSE)
常駐的 SSE 連線,讓伺服器能**主動通知**客戶端。目前只用來即時告知「你被踢下線了」。登入後就建議開著,斷線時自動重連(建議 3 秒後)。

| 事件 | 資料 | 說明 |
|---|---|---|
| `ready` | `{ "ok": true }` | 連線建立 |
| `session_replaced` | `{ reason, device_name, message }` | 這個 session 失效了:另一台裝置登入(`reason: "replaced"`,`device_name` 是**新**裝置名稱);或登出、後台強制登出、帳號刪除(`reason: "revoked"`,`device_name` 為 `null`)。收到後伺服器關閉連線,客戶端應清除 token 並回到登入畫面。**自己呼叫 `logout` 時,自己的事件通道也會收到**,客戶端要避免把它當成「被踢」而顯示錯誤提示 |

```
event: ready
data: {"ok":true}

event: session_replaced
data: {"reason":"replaced","device_name":"iPad","message":"你的帳號已在其他裝置登入"}
```

每 ~20 秒一則 `: hb` 註解心跳。若這個通知遺失(Pub/Sub 是 at-most-once),最壞情況舊 token 還能再用約 5 秒,之後任何請求都會回 `401 SESSION_REPLACED`。

---

## 後台 API (Admin)

給客服使用的管理介面,**獨立於對外 gateway**。

| 項目 | 說明 |
|---|---|
| **Base URL** | `http://localhost:8090/api`(僅綁定 `127.0.0.1`) |
| **認證** | **無**(依需求不做權限控管) |
| **⚠ 注意** | 能查看對話內容、調整點數、強制登出使用者。**上線前必須加上身分驗證、角色權限與操作稽核。** |

此外 `GET /`(`http://localhost:8090/`)是後台的網頁介面。錯誤格式與對外 API 相同。

### `GET /api/overview`
系統總覽(後台首頁每 5 秒輪詢它)。

回應鍵:`auth`、`chat`、`billing`、`redis`、`cache`。任一後端服務暫時不可用時,該鍵會是 `{ "error": "…" }` 而不是整個請求失敗。

```json
{
  "auth":    { "users": 11, "active_sessions": 10, "new_users_24h": 11 },
  "chat":    { "conversations": 9, "messages": 67, "streaming_now": 0, "failed_total": 4,
               "billing_pending": 0, "active_generations_this_instance": 0 },
  "billing": { "accounts": 9, "total_balance": 1760, "total_held": 0, "active_holds": 0,
               "total_granted": 1810, "total_charged": 50, "charges_24h": 25 },
  "redis":   { "state": { "used_memory": "1.60M", "maxmemory_policy": "noeviction", "connected_clients": 10,
                          "ops_per_sec": 1, "evicted_keys": 0, "keyspace_hit_rate": 0.99 },
               "cache": { "used_memory": "1.36M", "maxmemory_policy": "allkeys-lru", "…": "…" } },
  "cache":   [ { "name": "chat/recent", "hit": 35, "miss": 8, "hit_rate": 0.8139 } ]
}
```
`cache[]` 是應用層快取命中率:`name` 為 `服務/快取名`,另可能有 `coalesced`(合併回源)與 `error`(Redis 故障)。`active_generations_this_instance` 只代表回應這次請求的那一個 chat instance。

### `GET /api/users`
搜尋使用者(帳號或暱稱,不分大小寫的部分比對),附點數。

| 參數 | 說明 |
|---|---|
| `q` | 搜尋字串,最長 64 字;省略則列出全部 |
| `offset` | 位移,預設 0;每頁固定 50 筆 |

```json
{ "items": [ {
  "id": "bb1e5f35-a87e-47b3-8b78-c8e0570eeb53", "username": "doc_mw77b8ym", "nickname": "文件",
  "created_at": "2026-11-08T02:16:30.346Z",
  "device_name": "iPad", "session_started_at": "2026-11-08T02:16:30.405Z",
  "points": { "balance": 198, "held": 0, "available": 198 }
} ] }
```
`device_name` / `session_started_at` 為 `null` 表示目前未登入。`points` 取不到時為 `null`。

### `POST /api/users/{id}/grant`
補點(客服)。會寫入使用者可見的點數明細,註記 `[後台] {reason}`。

| 欄位 | 型別 | 必填 | 限制 |
|---|---|:-:|---|
| `amount` | int | ✓ | 1–1,000,000 |
| `reason` | string | | 最長 100 字,預設「客服補點」 |

`200` → `{ "ok": true, "already": false, "balance": 208 }`(`balance` 為補點後總點數)。

### `POST /api/users/{id}/logout`
強制登出。使用者在線的裝置會立即收到 `session_replaced`(`reason: "revoked"`)。

`200` → `{ "revoked": true }`(`false` 表示本來就沒有登入)。

### `GET /api/users/{id}/ledger`
該使用者的完整點數明細(格式同[使用者端](#get-v1pointsledger))。參數:`before_id`;每頁固定 50 筆。

### `GET /api/users/{id}/conversations`
該使用者的對話列表,另含 `character_name`、`character_avatar`、`user_id`。

### `GET /api/conversations/{id}/messages`
對話內容(**個資,上線需控管**)。參數:`before_seq`;每次最多 100 則,由舊到新。比使用者端多出管理用欄位:

| 欄位 | 說明 |
|---|---|
| `attempt` | 這則回覆第幾次嘗試(失敗重試時遞增) |
| `cost` | 成功回覆扣的點數(失敗為 0) |
| `billing_state` | `none` / `held` / `settle_pending` / `settled` / `release_pending` / `released`。長時間停在 `*_pending` 代表結算有問題 |

### `GET /api/characters`
列出**所有**角色(含已下架),且包含 `persona`(system prompt)、`model`、`status`、`sort_order`。

### `POST /api/characters`
新增角色。`201` 回傳角色。`slug` 重複 → `409 SLUG_TAKEN`。

### `PUT /api/characters/{id}`
更新角色(**整筆取代**,請帶完整欄位)。成功後會立即清除 Redis 快取並通知所有 chat instance 清本機快取,不需重啟。

| 欄位 | 型別 | 必填 | 限制 |
|---|---|:-:|---|
| `slug` | string | ✓ | `[a-z0-9_-]`,2–32 字,唯一 |
| `name` | string | ✓ | 1–32 字 |
| `tagline` | string | | 最長 100 字 |
| `avatar` | string | | emoji,1–8 字,預設 `🙂` |
| `persona` | string | ✓ | system prompt,1–1000 字(每次請求都要重送給模型並計費,所以限制長度) |
| `greeting` | string | ✓ | 開場白,1–500 字 |
| `price` | int | ✓ | 每則回覆點數,0–1000 |
| `model` | string \| null | | 指定模型;`null` 用系統預設。**只對主要供應商生效**(模型名稱是各家專屬的,備援會用自己設定的模型) |
| `status` | `"active"` \| `"disabled"` | | 預設 `active`;`disabled` 即下架 |
| `sort_order` | int | | 排序,預設 100 |

> 沒有刪除角色的端點。要讓角色消失請改 `status: "disabled"`(使用者端列表不再出現,既有對話的歷史保留)。

---

## 錯誤碼總表

### HTTP 層(JSON 錯誤)

| 狀態 | `code` | 說明 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 參數驗證失敗;`message` 形如 `欄位:原因` |
| 401 | `UNAUTHENTICATED` | 未登入 / token 無效或過期 |
| 401 | `SESSION_REPLACED` | 已在其他裝置登入 |
| 401 | `SESSION_EXPIRED` | session 已登出 / 被強制登出 / 帳號已刪除 |
| 401 | `INVALID_CREDENTIALS` | 帳號或密碼錯誤(login) |
| 402 | `INSUFFICIENT_POINTS` | 點數不足;帶 `required`、`balance`、`available` |
| 403 | `INVALID_CREDENTIALS` | 密碼錯誤(刪除帳號) |
| 404 | `NOT_FOUND` | 資源不存在 / 不是你的 / 路徑不存在 |
| 409 | `USERNAME_TAKEN` | 帳號已被使用 |
| 409 | `GENERATION_IN_PROGRESS` | 該對話已有回覆進行中 |
| 409 | `CHARACTER_UNAVAILABLE` | 角色已下架 |
| 409 | `DUPLICATE_IN_FLIGHT` | 相同 `client_msg_id` 同時送出 |
| 409 | `RETRY_NOT_LATEST` / `RETRY_CONFLICT` | 重試的不是最新一則 / 狀態已改變 |
| 409 | `SLUG_TAKEN` | (後台)角色 slug 重複 |
| 429 | `RATE_LIMITED` | 被限流;帶 `retry_after`(秒) |
| 500 | `INTERNAL` | 伺服器內部錯誤 |
| 502 | `BAD_GATEWAY` | gateway 連不上後端服務 |
| 503 | `SERVICE_UNAVAILABLE` / `UPSTREAM_UNAVAILABLE` | 依賴的服務暫時不可用 |
| 503 | `SERVER_BUSY` / `SERVER_DRAINING` | 負載保護 / 滾動更新中 |

### 串流層(`error` 事件)
見[串流協定](#error-事件的-code)。

---

## Postman

檔案(都在 [`docs/api/`](.)):

| 檔案 | 說明 |
|---|---|
| `chat-app.postman_collection.json` | 所有端點(含後台)。附範例回應與測試腳本 |
| `chat-app.postman_environment.json` | 環境變數 `baseUrl`、`adminUrl` |

**匯入**:Postman → Import → 選這兩個檔案 → 右上角環境切到「Chat APP (local)」。先確認系統已 `docker compose up -d`。

**用法**

1. 從上到下**依序**執行(或對整個 Collection 按 Run)。`Auth → Register` 會產生一個全新的測試帳號並把 `token` 存進 collection 變數,之後所有請求自動帶上。其餘會用到的變數(`characterId`、`conversationId`、`assistantMessageId`……)也由前面的請求自動寫入。
2. **串流端點**(送訊息、續傳):Postman 會等串流結束(`done` 後伺服器關閉連線)再一次顯示完整的事件文字。想看逐字出現請用 `curl -N`。
3. `Auth → Login (第二台裝置)` 會把第一台踢掉,接著的 `驗證舊 token 已失效` 會示範 `SESSION_REPLACED`。
4. **`Events → 開啟事件通道` 是常駐連線,不會自己結束**,Collection Runner 會卡在這一步,請不要把它放進自動執行(它在獨立的 `Events (長連線)` 資料夾,Run 時取消勾選即可)。
5. 後台資料夾打的是 `adminUrl`(預設 `http://localhost:8090`),不需要 token。
6. 最後的 `Account → 刪除帳號` 會刪掉這次的測試帳號。

**命令列執行**(不需要安裝 Postman,在 compose 網路內跑;**不含**常駐的 Events 資料夾):
```bash
docker run --rm --network chat-app_default \
  -v "$PWD/docs/api:/etc/newman" postman/newman:alpine \
  run chat-app.postman_collection.json \
  --folder Auth --folder Characters --folder Conversations --folder Points \
  --folder "Admin (後台, 無權限)" --folder Account \
  --env-var baseUrl=http://gateway:8080 --env-var adminUrl=http://admin:8090
```
實測結果:**35 個請求、80 項斷言、0 失敗**,可連續重複執行。

**副作用(請知悉)**
- 每次完整執行會註冊一個新的測試帳號(最後的 `Account → 刪除帳號` 會刪掉它),並**在後台新增一位已下架的測試角色**(`slug` 以 `pm_` 開頭)。沒有刪除角色的 API,若想清掉可直接刪資料庫:`DELETE FROM characters WHERE slug LIKE 'pm\_%' AND status='disabled'`(在 `character` 資料庫),然後清 `redis-cache` 的 `char:*`。
- 註冊與登入受限流(每 IP 每分鐘 30 次),完整執行一次用掉 5 次(實測)。
- 必須**依序**執行:後面的請求依賴前面存進 collection 變數的值(`token`、`conversationId`……)。單獨執行某個請求前,先把它依賴的變數跑出來。
- 選用的查詢參數(例如 `before_id`)預設是**停用**的,要用請在 Params 勾選;空值的參數會被後端判為 `400`。

**curl 範例**
```bash
# 註冊
curl -s localhost:8080/v1/auth/register -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123","device_id":"mac-1","device_name":"MacBook"}'

# 串流送訊息(-N 關閉緩衝才看得到逐字)
curl -N localhost:8080/v1/conversations/$CONV/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"content\":\"你好\",\"client_msg_id\":\"$(uuidgen)\"}"
```
