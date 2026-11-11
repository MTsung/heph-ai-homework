# 微服務清單

位置:`backend/services/`(Chat APP)與 `backend/booking/services/`(訂位代辦)。

| 服務 | 說明 |
|---|---|
| gateway | 唯一對外入口(:8080)。驗證 JWT 與單一裝置、限流、反向代理(含 SSE 直通) |
| auth | 註冊、登入、session 管理、刪除帳號(Outbox 事件) |
| character | AI 角色資料 CRUD,使用 Redis 快取 |
| chat | 對話與訊息、串流生成、LLM 呼叫與備援、補償(reaper) |
| billing | 點數預扣 → 結算/釋放、帳本,保證不超扣 |
| admin | 後台 API 與單頁網頁(僅本機 :8090,無權限控管) |
| booking | AI 代辦訂位:需求解析、方案、確認、送出與補償 |
| browser-agent | Python browser-use agent,操作享樂地圖測試店家完成訂位(只支援 Gemini) |

共用基礎設施:PostgreSQL(每服務一個資料庫)、redis-state、redis-cache。
