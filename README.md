# Chat APP — AI 陪伴 App

使用者可以和多位 AI 角色聊天:回覆**逐字串流**顯示、角色記得先前聊過的事、跨裝置看到同一份對話紀錄、每則回覆消耗點數並可查明細。
另有 **AI 代辦(訂餐廳)**:一句話提出需求 → AI 找店、補齊資料、整理方案 → 使用者確認 → 送出訂位 → 隨時查結果。設計見 [`docs/booking/DECISIONS.md`](docs/booking/DECISIONS.md)。

| 部分 | 技術 | 位置 |
|---|---|---|
| 後端(微服務) | **Bun** + TypeScript + Hono,PostgreSQL,Redis | `backend/` |
| 客戶端 | Flutter(macOS) | `app/` |
| 後台 | 單頁 HTML(無權限控管) | `backend/services/admin/` |
| 架構設計文件 | | [`docs/system-design/ARCHITECTURE.md`](docs/system-design/ARCHITECTURE.md) |
| API 文件與 Postman | | [`docs/api/API.md`](docs/api/API.md)、[`docs/api/chat-app.postman_collection.json`](docs/api/chat-app.postman_collection.json) |
| 訂位代辦(後端題) | 設計決策、API | [`docs/booking/DECISIONS.md`](docs/booking/DECISIONS.md)、[`docs/api/BOOKING-API.md`](docs/api/BOOKING-API.md) |
| AI 協作紀錄 | | [`docs/AI-LOG.md`](docs/AI-LOG.md) |
| 題目 | 兩份作業 PDF | `assignments/` |

## 快速開始

需要:Docker(含 Compose)、Flutter(跑客戶端用)。**不需要任何 API key** —— 預設使用內建的 mock 模型。

```bash
# 1. 啟動整個後端(PostgreSQL、2 個 Redis、8 個微服務 + 訂位模擬器)
docker compose up -d --build

# 2. 跑客戶端(macOS)
cd app && flutter run -d macos

# 3. 後台(僅本機)
open http://localhost:8090
```

啟動後註冊一個帳號就能聊天。註冊會贈送 200 點。

### 驗證

```bash
# 端到端冒煙測試(36 項檢查:單一裝置、串流、冪等、失敗退點、斷線續傳、點數不超扣…)
docker compose --profile tools run --rm tools bun scripts/smoke.ts

# 訂位代辦端到端驗證(68 項:找店、補資料、確認、過期、客滿、結果不明、同時上限、點數…)
docker compose --profile tools run --rm --no-deps tools bun booking/scripts/booking-smoke.ts

# Flutter:解析器 + widget 測試(不需後端)與對真實後端的整合測試(需先 docker compose up)
cd app && flutter test
```

## 訂位代辦(AI 代辦)

```
使用者:幫我訂這週五晚上 7 點,4 個人,信義區的日式料理
 → 找到 4 家可以線上訂位的店,請選擇          (只列出搜尋得到訂位連結的店)
 → 選「夜行居酒屋」→ 這家還需要:姓名、電話、座位偏好(吧台/包廂)   (每家店要的資料不同)
 → 方案:2026-11-13(週五)19:00、4 位、王小明 0912…、包廂   (10 分鐘內有效)
 → 使用者確認 → 送出 → 查到「訂位成功,代號 WF-XXXXXX」          (成功才扣 3 點)
```

- 沒有真實的 Google、餐廳網站、訂位平台可用,所以 `booking-sim` 服務**模擬**這三者(含客滿、處理很慢、成功了但回應沒回來、平台第一次回 503 等故障行為)。
- **不需要任何金鑰**:預設用規則解析使用者的話;在 `.env` 設定真實模型後會改用 LLM 解析(失敗時自動退回規則)。
- 初期操作網頁的訂位**同時最多 3 筆**(`MAX_CONCURRENT_BOOKINGS`),第 4 筆確認時回 `503 SERVER_BUSY`;訂位管道是介面,之後換成平台 API 不必動其他部分。
- **真實實驗目標:享樂地圖(JoyMap)測試店家「TEST01：Jump！Jump！」。** 使用者提到「Jump」或「TEST01」時,由 `browser-agent` 在 Docker 裡以 browser-use 操作 `BROWSER_BOOKING_URL`(預設 `https://www.joymap.tw/store/jump888`)。LLM 只在店家頁選人數、日期、時段;訂位頁的欄位由程式填寫並與已確認方案逐項比對,「確認訂位」也只能由程式按下。最終送出預設關閉,於 `.env` 設 `BROWSER_AGENT_SUBMIT_ENABLED=true` 才會開啟。
- 模擬器在主機的 `127.0.0.1:9190` 可以看「對方實際收到哪些訂位」:`curl localhost:9190/__debug/reservations`。

**用 curl 試一遍**(註冊拿到 token 後;完整說明與範例見 [`docs/api/BOOKING-API.md`](docs/api/BOOKING-API.md)):

```bash
T=<token>
curl -s -X POST localhost:8080/v1/bookings -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"text":"幫我訂這週五晚上 7 點,4 個人,信義區的日式料理"}'          # → pending.options 是候選店家
curl -s -X PATCH localhost:8080/v1/bookings/<id>/slots -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"restaurant_id":"r_sakura"}'                                       # → 問這家店要的資料
curl -s -X PATCH localhost:8080/v1/bookings/<id>/slots -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"contact":{"name":"王小明","phone":"0912345678"}}'                  # → 方案(plan.hash)
curl -s -X POST localhost:8080/v1/bookings/<id>/confirm -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"plan_hash":"<plan.hash>"}'                                        # → 202,之後 GET /v1/bookings/<id> 查進度
```

> **已經有舊的 Postgres volume**(在加入訂位服務之前就 `docker compose up` 過)的話,`init.sql` 不會重跑,需要手動建立資料庫一次:
> `docker compose exec postgres psql -U chatapp -d chat -c "CREATE DATABASE booking"`,或 `docker compose down -v` 重來(會清掉所有資料)。

### 接上真實的模型(Gemini 主要 + 備援)

預設用內建的 mock 模型。要接真實模型:`cp .env.example .env`,填入金鑰,再 `docker compose up -d chat`。

```bash
# .env
LLM_PROVIDERS=gemini,groq        # 有序清單:第一個是主要,其餘依序備援
GEMINI_API_KEY=...               # https://aistudio.google.com/apikey
GROQ_API_KEY=...                 # 備援;沒有第二家的金鑰也可以只填 gemini
```

**切換模型 = 改 `LLM_PROVIDERS`**(工廠依名稱建立,可用:`mock` / `gemini` / `groq` / `openai` / `ollama`),不用改程式。
指定模型:`gemini:gemini-2.5-flash,groq`。模型更新很快,所以模型名稱放環境變數(`GEMINI_MODEL`)而不是寫死。
新增供應商 = 在 `backend/shared/llm/factory.ts` 的註冊表加一行。

**備援**:主要供應商失敗(逾時、429、5xx、金鑰錯誤、空回覆)且**還沒送出任何字**時,自動換下一家。
兩家都不可用 → 使用者看到「目前系統有問題,請稍後再試」,**不扣點**。已經送出部分文字後才失敗不會偷偷換家(畫面上已有字),回報錯誤讓使用者重試。
供應商連續失敗 3 次會暫停 20 秒(斷路器),避免每個使用者都要先等完逾時。

**成本控制**(輸入與輸出都有上限,預設值見 `.env.example`):

| | 預設 | 說明 |
|---|---|---|
| 輸出 | 300 token | 單次回覆上限 |
| 歷史 | 12 則 / 2500 字 / 單則 400 字 | 每次請求都要重送並計費 |
| 使用者單則 | 500 字 | |
| Gemini 思考 | 關閉 | 思考 token 以**輸出價**計費;不同世代參數不同,見 `GEMINI_THINKING` |

實際用量記在每則訊息上(`provider`、`input_tokens`、`output_tokens`),並有 Prometheus 指標 `chat_llm_tokens_total`,可以對帳單。

**驗證備援(不需要金鑰)**:用假的 LLM 伺服器模擬各種故障,44 項檢查——

```bash
E=backend/scripts/llm-check.env
docker compose --env-file $E --profile tools up -d --build fake-llm chat gateway
docker compose --env-file $E --profile tools run --rm --no-deps tools bun scripts/llm-check.ts
docker compose up -d chat gateway        # 還原正常設定
```

**驗證你的金鑰**(真實的 Gemini):`docker compose exec chat bun scripts/llm-ping.ts`,會印出實際使用的供應商、模型、延遲與 token 數。

## 架構一覽

```
 Flutter macOS ──HTTPS/SSE──▶ gateway :8080 ──┬─▶ auth       使用者、單一裝置 session
 後台網頁 :8090(僅本機)                       ├─▶ character  角色資料(Redis cache-aside)
                                              ├─▶ chat       對話、訊息、串流生成、LLM
                                              ├─▶ booking    AI 代辦:訂位需求、方案、確認、送出、補償
                                              │     └─▶ booking-sim  模擬 Google 搜尋 / 餐廳網頁 / 訂位平台
                                              └─▶ billing    點數:預扣 → 結算/釋放、帳本
                       PostgreSQL(每個服務一個資料庫)   redis-state / redis-cache
```

只有 gateway(8080)與後台(127.0.0.1:8090)對外開埠;其餘服務只在 compose 內部網路。
詳細設計、取捨與實測數據見 [`docs/system-design/ARCHITECTURE.md`](docs/system-design/ARCHITECTURE.md)。

## 重要設計(摘要)

- **單一裝置**:每位使用者只有一個有效 session。新裝置登入會立刻讓舊裝置失效,並即時推送通知。
- **生成與連線脫鉤**:使用者斷線/關掉 App,AI 回覆仍在伺服器完成並存檔,回來時可續傳。
- **點數不超扣**:`預扣 → 結算/釋放` 兩階段,以單一條件式 SQL 保證;失敗的回覆不扣點。
- **Redis 分兩個實例**:`redis-state`(session/鎖/串流,不淘汰)與 `redis-cache`(快取,LRU 淘汰)。
- **歷史訊息用 keyset 分頁**(`seq` 游標),翻到任意深度成本不變。
- **訂位:確認什麼就只送出什麼**:方案有雜湊值,確認必須帶上它;確認後的內容在資料庫層凍結。結果不明(送出了但沒收到回覆)時**不重送**、不扣點。

## 專案結構

```
assignments/             題目:兩份作業 PDF(僅本機參考,已列入 .gitignore,不在版控內)
docs/                    交付的文件(只放文件,不放程式)
  system-design/         ARCHITECTURE.md
  api/                   API.md、BOOKING-API.md、Postman collection 與 environment
  booking/               DECISIONS.md(訂位代辦:假設、取捨、驗證)
docker-compose.yml       一鍵啟動全部(build context 指向 backend/;以 include 載入訂位擴充)
app/                     程式:Flutter macOS 客戶端
backend/                 程式:後端
  Dockerfile、package.json、bun.lock、tsconfig.json
  shared/                各服務共用:設定、Redis 工具(快取/鎖/限流)、事件、SSE、內部 HTTP client、llm/(模型供應商工廠與備援)
  services/              Chat APP(系統設計題)
    gateway/             JWT + 單一裝置驗證、限流、反向代理(含 SSE 直通)
    auth/                註冊登入、session、刪除帳號(Outbox 事件)
    character/           角色 CRUD + Redis 快取
    chat/                對話、訊息、Generation(串流)、reaper(補償)
    billing/             點數預扣/結算/釋放、帳本
    admin/               後台 API + 單頁網頁
  scripts/               smoke.ts(聊天冒煙)、loadtest.ts(壓測)
  docker/                Postgres 初始化
  booking/               訂位代辦擴充(後端題),共用 shared/、gateway、billing、PostgreSQL、Redis
    docker-compose.booking.yml   booking / booking-sim / browser-agent 的服務定義(由根目錄 compose include)
    services/
      booking/           AI 代辦:對話流程、方案、確認、執行與補償、訂位管道(網頁表單 / 平台 API / browser-agent)
      booking-sim/       訂位世界的模擬器(假 Google、餐廳網頁、合作平台)
      browser-agent/     Python browser-use agent:已授權的享樂地圖測試店家(站點程式在 src/joymap.py)
    scripts/             booking-smoke.ts(訂位端到端)
```

## 常用指令

```bash
docker compose logs -f chat                          # 看某個服務的日誌
docker compose up -d --scale chat=3 chat             # 把 chat 擴展成 3 個 replica(gateway 會 round-robin)
                                                     # 擴充後我曾看到新 replica 沒有立刻分到流量,重啟 gateway 後才平均(原因未查明)
docker compose down -v                               # 停止並清除所有資料
cd backend && bun install && bun run typecheck       # 本機型別檢查(需安裝 Bun)
```

## 後台注意事項

後台**沒有任何權限控管**(依需求),只綁定在 `127.0.0.1`。它能查看對話內容與調整點數,
正式環境必須加上身分驗證、角色權限與操作稽核後才能使用。
