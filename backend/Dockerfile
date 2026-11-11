# 所有後端服務共用同一個 image,啟動時用 SERVICE 環境變數(或 command)決定要跑哪一個。
# Bun 直接執行 TypeScript,沒有 build 步驟;image 只需要 production 依賴與原始碼。
# 這是 Bun workspaces monorepo:安裝依賴前要先放好每個 workspace 的 package.json(lockfile 以它們為準)。
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY services/gateway/package.json services/gateway/
COPY services/auth/package.json services/auth/
COPY services/character/package.json services/character/
COPY services/chat/package.json services/chat/
COPY services/billing/package.json services/billing/
COPY services/admin/package.json services/admin/
COPY booking/services/booking/package.json booking/services/booking/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production \
    # Bun 的 fetch 預設最多同時 256 個對外請求,超過會排隊。
    # gateway 每條轉發中的 SSE、chat 每條進行中的 LLM 呼叫都佔一個,必須調高。
    BUN_CONFIG_MAX_HTTP_REQUESTS=65535
# 依賴(含各 workspace 底下的 node_modules 連結)
COPY --from=deps /app ./
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
# 訂位代辦(擴充):獨立目錄,共用 packages/shared 與同一個 image
COPY booking ./booking
USER bun
# 預設用 SERVICE 指定;compose 內每個服務都會設定。訂位擴充的服務另設 SERVICE_ROOT=booking/services
ENV SERVICE=gateway SERVICE_ROOT=services
CMD ["sh", "-c", "exec bun ${SERVICE_ROOT}/${SERVICE}/src/index.ts"]
