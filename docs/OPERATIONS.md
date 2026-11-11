# 維運

環境是單機 `docker compose`,多 replica 用同一套設定(`docker-compose.scale.yml`)。所有部署操作都走 `scripts/release.sh`。

## 1. 部署與更新

```bash
cp .env.example .env              # 第一次:填 POSTGRES_PASSWORD、INTERNAL_TOKEN、JWT_SECRET
scripts/release.sh deploy         # 單機
scripts/release.sh deploy --scale # 多 replica(見 §4)
```

- 版本 = git commit。有未 commit 的修改要加 `--allow-dirty`。
- 部署前:檢查 PostgreSQL 連線數預算、等進行中的訂位結束(最多 60 秒)、備份資料庫到 `.db-backup/`。
- 逐個服務滾動更新:新版 healthy 才停舊版,多 replica 時不中斷。
- 部署後驗證:容器都 healthy、觀察 15 秒無重啟、用暫時帳號走一遍主要流程。
- **驗證失敗不會自動退回**,只報告,由人決定是否 rollback。
- `release.sh status` 看目前版本、上一版、各容器實際版本。

## 2. Rollback(人工)

```bash
scripts/release.sh status              # 確認上一版的 image 還在
scripts/release.sh rollback            # 退回上一版,不重新 build,約 1 分半
scripts/release.sh rollback <版本>      # 退回指定版本
```

- 部署中途失敗、新舊版混在一起時,`rollback` 不帶參數會拉回「最後一個成功的版本」。
- 退回後上一版會變成壞版本,**不要再 rollback 一次**;修好後用 `deploy`。
- 只保留最近 5 個版本的 image(只在本機)。更舊的版本:`git checkout <commit> && release.sh deploy`。
- **不要直接下 `docker compose up`**:沒有版本資訊時會把服務換成 `:local`。要用 compose 請用 `release.sh compose <參數>`。
- `.env` 設定改壞:還原 `.env` 後 `release.sh compose up -d`,不必 rollback。
- 進行中的訂位在更新 booking 時會變成「結果不明」(不扣點,要人工向店家確認)。

## 3. Migration

服務啟動時自動往前套用(advisory lock,多 replica 安全)。

**規範(rollback 能安全的前提):**
- 只新增欄位 / 表 / 索引,舊版程式也要能跑。
- 要刪欄位或改名:拆兩個版本,先上不再使用的程式,下一版才刪。

**倒退(down):**
- 每個 migration 可寫 `down`。`001_init` 刻意不寫,避免一個指令清光資料表;開發環境重來用 `docker compose down -v`。
- 有風險的 `down` 會自帶防護(例如還有進行中的訂位就拒絕)。
- 倒退後服務重啟會**再次套用**,所以順序固定:**先 rollback 程式,再倒退 migration**。

```bash
scripts/release.sh rollback                              # 1. 先把程式退回舊版
scripts/release.sh migrate status                        # 2. 看各服務 migration 狀態
scripts/release.sh migrate down chat --yes               # 3. 倒退最後 1 個(--steps N 倒退多個)
```

- `down` 用「含有該 migration 的版本」的 image 執行(預設是剛退回來的壞版本),`--version` 可指定。
- 目前版本就是含該 migration 的版本時會拒絕。
- 會丟資料(例如被移除欄位裡的內容),事先看 `status` 顯示的備份。
- 正式環境預設拒絕,由 `--yes` 明確放行。

## 4. 水平擴充

```bash
scripts/release.sh deploy --scale                       # 各服務預設 2 個 replica,前面多一層 nginx
CHAT_REPLICAS=3 GATEWAY_REPLICAS=3 scripts/release.sh deploy --scale
scripts/release.sh compose up -d --no-deps --scale chat=3 chat   # 只調整單一服務
scripts/release.sh budget                               # 改數量前,檢查 PostgreSQL 連線數
```

環境變數:`GATEWAY_REPLICAS`、`AUTH_REPLICAS`、`CHARACTER_REPLICAS`、`BILLING_REPLICAS`、`CHAT_REPLICAS`、`BOOKING_REPLICAS`(預設 2),`EDGE_PORT`(預設 8080)。

**第一次從單機切換:**
1. `COMPOSE_FILE=docker-compose.yml:docker-compose.scale.yml scripts/release.sh budget`
2. 若顯示超出預算(執行中的 `max_connections` 是 300):
   `COMPOSE_FILE=docker-compose.yml:docker-compose.scale.yml docker compose up -d --no-deps postgres` 重建 PostgreSQL 套用 500。資料保留,但幾秒內所有服務連不上資料庫,請在低峰期做。
3. `scripts/release.sh deploy --scale`(之後 `deploy` / `rollback` 會記住這個模式)。

**確認每個 replica 都有流量:**
```bash
export INTERNAL_TOKEN=$(grep -E '^INTERNAL_TOKEN=' .env | cut -d= -f2-); INTERNAL_TOKEN=${INTERNAL_TOKEN:-dev-internal-token-change-me}
scripts/release.sh compose exec -T gateway wget -qO- --header "x-internal-token: $INTERNAL_TOKEN" http://127.0.0.1:8080/internal/stats
```
輸出的 `replicas` 是 gateway 看到的各服務 replica 數。

**重點:**
- 流量路徑:用戶端 → nginx(`edge`)→ gateway → 服務;服務之間的呼叫也自己分流。
- 服務無狀態:登入狀態、鎖、串流在 Redis,資料在 PostgreSQL。
- 連線數預算:Σ(replica × `*_PG_POOL_MAX`) + 更新時最大服務暫時加倍 < `max_connections` − 20。`budget` 以**執行中的**資料庫為準,`deploy` 超出會中止。再往上加 PgBouncer。
- 新 replica 約 1 秒內被分流(早期要重啟 gateway 的問題已修:Bun 的 `dns.resolve4()` 不會更新,改用 `dns.lookup`)。
- 改 `backend/docker/nginx/edge.conf` 後:`release.sh compose up -d --no-deps --force-recreate edge`。
- 實測(單機 Docker):滾動部署期間持續送 GET + POST,18,031 個請求 0 失敗;rollback 期間 10,331 個請求 0 失敗。這是「更新不丟請求」,不是容量。

**上限:**
- 訂位並行是全域 3 筆,多開 booking 不會增加。
- browser-agent 沒放進 scale 設定,多開沒測。
- 每個 chat replica 各自一份 LLM 斷路器與並行限制。
- PostgreSQL / Redis 各 1 個,是單點。
- admin 不要多開、不要對外。

## 5. 怎麼知道系統出問題

**端點:** `/healthz`(存活)、`/readyz`(依賴可用;關閉中回 503)、`/metrics`(Prometheus)。gateway 與 admin 的 `/readyz`、`/metrics` 要帶 `x-internal-token`。

```bash
docker compose ps                              # 哪個不是 healthy
docker compose logs --since 10m <服務>          # JSON 日誌,含 reqId
```

**日誌:** 預設只記 5xx 與超過 1 秒的請求(`LOG_REQUESTS=1` 全開);`x-request-id` 貫穿各服務。

**該看的指標:**

| 指標 | 異常代表 |
|---|---|
| `http_request_duration_seconds` | 5xx 比例、p95 變高 |
| `chat_generations_total{outcome}` | AI 回覆失敗變多 |
| `chat_time_to_first_token_seconds` | 使用者覺得 AI 很慢 |
| `chat_llm_failovers_total`、`chat_llm_breaker_open` | 供應商出錯、備援被觸發 |
| `chat_billing_settle_failures_total`、`booking_billing_failures_total` | 結算 / 釋放點數失敗(持續增加才要處理) |
| `booking_executions_total{outcome}` | 訂位失敗或結果不明變多 |
| `booking_busy_total` | 同時 3 筆上限被打滿 |

**常見狀況:**
- AI 沒回應 → `chat_llm_breaker_open`、`logs chat`。
- 點數被扣但沒結果 → `settle_failures`、billing 日誌;後台可查帳本。
- 訂位卡住 → 後台看狀態;`unknown` 要人工向店家確認。
- 服務一直重啟 → `logs <服務>`,常見是 `.env` 缺值或 migration 失敗。

## 6. 目前沒有的

- 沒有告警:指標都有,但不會主動通知。
- 沒有 CI/CD 與遠端 image registry:image 只在這台機器上。
- 沒有自動備份排程:只有部署前備份一次。
- 單機:機器掛了服務就停。
- `down` 的資料還原流程(從備份復原)沒有實測。

## 7. 未來展望

**CI/CD**(GitLab CI、GitHub Actions 皆可):平台負責觸發與稽核,`release.sh` 繼續當主機上的部署邏輯。
- 合併後 CI 自動 build,以 commit SHA 當 tag,推到 registry。
- 部署與 rollback 各是一個 pipeline job,正式環境手動核准,job 以 ssh 執行 `release.sh`。
- 部署前的檢查(型別、`compose config`、`budget`)放進 CI。
- 要改:`release.sh` 支援從 registry 拉 image(目前只會本機 build);金鑰改放平台 secret。
- 若改用 Kubernetes / ECS,滾動更新與 rollback 由平台內建,CI/CD 流程不變。

**監控告警:** Prometheus 抓每個 replica 的 `/metrics`,對 5xx 比例、`chat_llm_breaker_open`、訂位失敗設告警。

**其他:** 託管資料庫與高可用、PgBouncer、自動備份排程與還原演練、金絲雀發佈、Kubernetes 多機編排。
