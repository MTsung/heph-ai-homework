# 所有後端服務共用同一個 image,啟動時用 SERVICE 環境變數(或 command)決定要跑哪一個。
# Bun 直接執行 TypeScript,沒有 build 步驟;image 只需要 production 依賴與原始碼。
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production \
    # Bun 的 fetch 預設最多同時 256 個對外請求,超過會排隊。
    # gateway 每條轉發中的 SSE、chat 每條進行中的 LLM 呼叫都佔一個,必須調高。
    BUN_CONFIG_MAX_HTTP_REQUESTS=65535
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared ./shared
COPY services ./services
COPY scripts ./scripts
USER bun
# 預設用 SERVICE 指定;compose 內每個服務都會設定
ENV SERVICE=gateway
CMD ["sh", "-c", "exec bun services/${SERVICE}/src/main.ts"]
