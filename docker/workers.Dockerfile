FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/workers/package.json packages/workers/

RUN npm ci --workspace=packages/shared --workspace=packages/workers

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/workers/ packages/workers/
COPY config/ config/

RUN npx prisma generate --schema=packages/shared/prisma/schema.prisma
RUN npm run build -w packages/shared && npm run build -w packages/workers

# ─── Production ─────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/shared/prisma packages/shared/prisma/
COPY --from=builder /app/packages/workers/package.json packages/workers/
COPY --from=builder /app/packages/workers/dist packages/workers/dist/
COPY --from=builder /app/config config/
COPY --from=builder /app/node_modules node_modules/

RUN mkdir -p /data/uploads /data/output

CMD ["node", "packages/workers/dist/index.js"]
