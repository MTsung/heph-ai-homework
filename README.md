# Chat APP — AI 陪伴 App

使用者可以和多位 AI 角色聊天:回覆**逐字串流**顯示、角色記得先前聊過的事、跨裝置看到同一份對話紀錄、每則回覆消耗點數並可查明細。

| 部分 | 技術 | 位置 |
|---|---|---|
| 後端(微服務) | **Bun** + TypeScript + Hono,PostgreSQL,Redis | `backend/` |
| 客戶端 | Flutter(macOS) | `app/` |
| 後台 | 單頁 HTML(無權限控管) | `backend/services/admin/` |
| 架構設計文件 | | [`docs/system-design/ARCHITECTURE.md`](docs/system-design/ARCHITECTURE.md) |
| API 文件與 Postman | | [`docs/api/API.md`](docs/api/API.md)、[`docs/api/chat-app.postman_collection.json`](docs/api/chat-app.postman_collection.json) |
| AI 協作紀錄 | | [`docs/AI-LOG.md`](docs/AI-LOG.md) |
| 題目 | 兩份作業 PDF | `assignments/` |

## 快速開始

需要:Docker(含 Compose)、Flutter(跑客戶端用)。**不需要任何 API key** —— 預設使用內建的 mock 模型。

```bash
# 1. 啟動整個後端(PostgreSQL、2 個 Redis、6 個微服務)
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

# Flutter:解析器 + widget 測試(不需後端)與對真實後端的整合測試(需先 docker compose up)
cd app && flutter test
```

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
新增供應商 = 在 `backend/services/chat/src/llm/factory.ts` 的註冊表加一行。

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

## 專案結構

```
assignments/             題目:兩份作業 PDF(僅本機參考,已列入 .gitignore,不在版控內)
docs/                    交付的文件(只放文件,不放程式)
  system-design/         ARCHITECTURE.md
  api/                   API.md、Postman collection 與 environment
docker-compose.yml       一鍵啟動全部(build context 指向 backend/)
app/                     程式:Flutter macOS 客戶端
backend/                 程式:後端
  Dockerfile、package.json、bun.lock、tsconfig.json
  shared/                各服務共用:設定、Redis 工具(快取/鎖/限流)、事件、SSE、內部 HTTP client
  services/
    gateway/             JWT + 單一裝置驗證、限流、反向代理(含 SSE 直通)
    auth/                註冊登入、session、刪除帳號(Outbox 事件)
    character/           角色 CRUD + Redis 快取
    chat/                對話、訊息、Generation(串流)、reaper(補償)、LLM provider
    billing/             點數預扣/結算/釋放、帳本
    admin/               後台 API + 單頁網頁
  scripts/               smoke.ts(冒煙)、loadtest.ts(壓測)
  docker/                Postgres 初始化
```

## 常用指令

```bash
docker compose logs -f chat                          # 看某個服務的日誌
docker compose up -d --scale chat=3 chat             # 把 chat 擴展成 3 個 replica(gateway 會自動 round-robin)
docker compose down -v                               # 停止並清除所有資料
cd backend && bun install && bun run typecheck       # 本機型別檢查(需安裝 Bun)
```

## 後台注意事項

後台**沒有任何權限控管**(依需求),只綁定在 `127.0.0.1`。它能查看對話內容與調整點數,
正式環境必須加上身分驗證、角色權限與操作稽核後才能使用。
