# Chat APP — AI 陪伴 App

和多位 AI 角色聊天的 App:回覆逐字串流、角色記得聊過的事、跨裝置同步對話、每則回覆扣點數。
另含 **AI 代辦(訂餐廳)**:一句話提出需求,AI 找店、補資料、出方案,使用者確認後送出訂位。

---

## 系統架構

```
 Flutter macOS ──HTTPS/SSE──▶ gateway :8080 ──┬─▶ auth
 後台網頁 :8090(僅本機)                       ├─▶ character
                                              ├─▶ chat
                                              ├─▶ booking ──▶ browser-agent
                                              └─▶ billing
                       PostgreSQL(每個服務一個資料庫)   redis-state / redis-cache
```

### 服務說明

| 服務 | 說明 |
|---|---|
| `gateway` | JWT 與單一裝置驗證、限流、反向代理(含 SSE) |
| `auth` | 註冊登入、session、刪除帳號 |
| `character` | 角色 CRUD,Redis 快取 |
| `chat` | 對話、訊息、串流生成、LLM 供應商備援 |
| `billing` | 點數預扣 → 結算/釋放、帳本 |
| `booking` | AI 代辦:需求理解、方案、確認、送出、補償 |
| `browser-agent` | Python browser-use,操作享樂地圖測試店家訂位頁 |
| `admin` | 後台 API + 單頁網頁(無權限控管,只綁 127.0.0.1) |

### 技術棧

- **後端**:Bun、TypeScript、Hono(Bun workspaces monorepo)
- **客戶端**:Flutter(macOS)
- **資料庫**:PostgreSQL(database-per-service)
- **快取 / 狀態**:Redis × 2(`redis-state` 不淘汰、`redis-cache` LRU)
- **AI**:Gemini、Groq、OpenAI、Ollama、mock(可設定主要 + 備援)
- **容器化**:Docker、Docker Compose

---

## 環境需求

- Docker(含 Compose)
- Flutter(跑客戶端)
- Bun(只有本機型別檢查才需要)

不需要任何 API key,預設使用內建的 mock 模型。

---

## 快速啟動

```bash
# 啟動後端(PostgreSQL、2 個 Redis、所有微服務)
docker compose up -d --build

# 跑客戶端
cd app && flutter run -d macos
```

註冊帳號即可聊天,註冊送 200 點。

> 若 Postgres volume 是在加入訂位服務前建立的,需手動建庫一次:
> `docker compose exec postgres psql -U chatapp -d chat -c "CREATE DATABASE booking"`

### 服務端點

| 服務 | URL |
|---|---|
| API Gateway | http://localhost:8080 |
| 後台 | http://localhost:8090 |
| PostgreSQL | `127.0.0.1:5432` |
| redis-state / redis-cache | `127.0.0.1:6379` / `127.0.0.1:6380` |

---

## 接上真實模型

```bash
cp .env.example .env
```

```env
LLM_PROVIDERS=gemini,groq    # 第一個是主要,其餘依序備援
GEMINI_API_KEY=...
GROQ_API_KEY=...
```

改完執行 `docker compose up -d chat`。可用供應商:`mock` / `gemini` / `groq` / `openai` / `ollama`,指定模型寫成 `gemini:gemini-2.5-flash`。

驗證金鑰:`docker compose exec chat bun scripts/llm-ping.ts`

其他設定(輸出上限、歷史長度、斷路器、訂位參數)見 [`.env.example`](.env.example)。

---

## 訂位代辦

拿到 token 後(完整說明見 [`docs/api/BOOKING-API.md`](docs/api/BOOKING-API.md)):

```bash
T=<token>
H=(-H "authorization: Bearer $T" -H 'content-type: application/json')

# 1. 提出需求
curl -s -X POST localhost:8080/v1/bookings "${H[@]}" -d '{"text":"幫我訂這週五晚上 7 點,4 個人,Jump"}'
# 2. 選店
curl -s -X PATCH localhost:8080/v1/bookings/<id>/slots "${H[@]}" -d '{"restaurant_id":"joymap-jump888"}'
# 3. 補資料 → 取得 plan.hash
curl -s -X PATCH localhost:8080/v1/bookings/<id>/slots "${H[@]}" -d '{"contact":{"name":"王小明","phone":"0912345678"}}'
# 4. 確認 → 202,再用 GET /v1/bookings/<id> 查進度
curl -s -X POST localhost:8080/v1/bookings/<id>/confirm "${H[@]}" -d '{"plan_hash":"<plan.hash>"}'
```

說「Jump」或「TEST01」會由 `browser-agent` 操作享樂地圖測試店家。最終送出預設關閉,設 `BROWSER_AGENT_SUBMIT_ENABLED=true` 才會真的訂位。

---

## 測試

```bash
# 端到端冒煙測試
docker compose --profile tools run --rm tools bun scripts/smoke.ts

# LLM 備援測試(用假的 LLM 伺服器模擬故障,不需金鑰)
E=backend/scripts/llm-check.env
docker compose --env-file $E --profile tools up -d --build fake-llm chat gateway
docker compose --env-file $E --profile tools run --rm --no-deps tools bun scripts/llm-check.ts
docker compose up -d chat gateway    # 還原

# Flutter(整合測試需先啟動後端)
cd app && flutter test

# 型別檢查
cd backend && bun install && bun run typecheck
```

---

## 常用指令

```bash
docker compose logs -f chat          # 看日誌
scripts/release.sh deploy [--scale]  # 部署(--scale = 多 replica)
scripts/release.sh rollback          # 退回上一版
docker compose down -v               # 停止並清除所有資料
```

部署細節見 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。

---

## 專案結構

```
app/                        Flutter macOS 客戶端
backend/
  packages/shared/          共用:HTTP、錯誤格式、DB、Redis 工具、SSE、LLM 工廠與備援
  services/                 gateway、auth、character、chat、billing、admin
  booking/services/         booking、browser-agent
  scripts/                  smoke.ts、loadtest.ts、llm-check.ts
  docker/                   Postgres 初始化
docs/                       文件
scripts/release.sh          部署腳本
```

每個 Bun 服務的 `src/` 分層(依賴只能由上往下):

```
routes/        HTTP 層:驗證請求 → 呼叫 service
services/      業務邏輯與 transaction 邊界
repositories/  SQL,一個資料表一個檔案
clients/       呼叫其他微服務
consumers/     Redis Stream 事件
jobs/          背景任務
db/migrations.ts  啟動時自動套用
```

---

## 文件

| 文件 | 內容 |
|---|---|
| [`docs/system-design/ARCHITECTURE.md`](docs/system-design/ARCHITECTURE.md) | 架構設計、取捨、實測數據 |
| [`docs/FEATURES.md`](docs/FEATURES.md) | 功能清單與設計理由 |
| [`docs/MICROSERVICES.md`](docs/MICROSERVICES.md) | 微服務清單 |
| [`docs/DATABASES.md`](docs/DATABASES.md) | 資料庫與資料表 |
| [`docs/ARCHITECTURE-DIAGRAMS.md`](docs/ARCHITECTURE-DIAGRAMS.md) | 架構圖與循序圖 |
| [`docs/api/API.md`](docs/api/API.md) | API 文件(另有 Postman collection) |
| [`docs/api/BOOKING-API.md`](docs/api/BOOKING-API.md) | 訂位代辦 API |
| [`docs/booking/DECISIONS.md`](docs/booking/DECISIONS.md) | 訂位代辦設計決策 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 部署與維運 |
| [`docs/AI-LOG.md`](docs/AI-LOG.md) | AI 協作紀錄 |
