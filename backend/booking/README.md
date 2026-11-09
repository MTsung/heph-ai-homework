# 訂位代辦(AI 代辦)擴充

後端題「AI 代辦:幫我訂餐廳」的實作。它是 Chat APP 的**擴充**,不是獨立系統:沿用 Chat APP 的 gateway(登入與限流)、billing(點數)、PostgreSQL、Redis 與 `backend/shared/`。設計、假設與驗證見 [`docs/booking/DECISIONS.md`](../../docs/booking/DECISIONS.md),API 見 [`docs/api/BOOKING-API.md`](../../docs/api/BOOKING-API.md)。

```
backend/booking/
  docker-compose.booking.yml   booking / booking-sim / browser-agent 的服務定義(根目錄 docker-compose.yml 以 include 載入)
  services/
    booking/         AI 代辦主服務:需求理解、對話流程、方案與確認、執行、補償(reaper)、訂位管道
    booking-sim/     模擬器:假 Google 搜尋、餐廳訂位網頁、合作訂位平台 API(含各種故障)
    browser-agent/   Python + browser-use:操作已授權的真實訂位網站(目前只有享樂地圖測試店家)
  scripts/
    booking-smoke.ts 端到端驗證(68 項)
```

## 與 Chat APP 的接點

| 接點 | 說明 |
|---|---|
| gateway | `/v1/bookings*` 轉發到 booking,帶上已驗證的 `x-user-id`;訂位的寫入另有每人每分鐘限流 |
| billing | 預扣 / 結算 / 釋放點數(`/internal/holds*`),帳本以 `ref_type` = `booking_turn` / `booking` 區分 |
| auth | 刪除帳號時的 `user.deleted` 事件(Redis Stream `events:user`),booking 收到後刪除該使用者的訂位 |
| admin | 使用者詳情頁的訂位紀錄與瀏覽器執行紀錄(讀 `browser-agent-artifacts` volume) |
| shared/ | HTTP app、內部 client、設定、DB、Redis、事件、LLM 供應商工廠 |
| PostgreSQL | 獨立的 `booking` 資料庫(`backend/docker/postgres/init.sql` 建立) |

Chat APP 的程式不 import 這個目錄的任何檔案;這個目錄只依賴 `backend/shared/`。

## 執行

```bash
docker compose up -d --build                                                      # 在 repo 根目錄,會一併啟動訂位擴充
docker compose --profile tools run --rm --no-deps tools bun booking/scripts/booking-smoke.ts
```

三個服務共用 Chat APP 的 Bun image(`backend/Dockerfile`),以 `SERVICE_ROOT=booking/services` 指到這個目錄;browser-agent 是獨立的 Python image。
