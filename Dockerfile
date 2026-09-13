# node:sqlite 需要 Node 22.5+，這裡用 24 以取得較穩定的實作。
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------- 依賴 ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- 建置 ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 讓 next.config.ts 切到 output: 'standalone'
ENV BUILD_STANDALONE=1
RUN pnpm build

# ---------- 執行 ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# SQLite 快取放在 volume 上，容器重建後索引不會消失。
ENV ARCHIVE_DB_PATH=/data/cache.db

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 \
  && mkdir -p /data && chown -R nextjs:nodejs /data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
