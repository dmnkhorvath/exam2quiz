FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/workers/package.json packages/workers/

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile --filter shared --filter workers

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/workers/ packages/workers/
COPY config/ config/

RUN pnpm exec prisma generate --schema=packages/shared/prisma/schema.prisma
RUN pnpm --filter shared run build && pnpm --filter workers run build

# ─── Production ─────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/shared/prisma packages/shared/prisma/
COPY --from=builder /app/packages/workers/package.json packages/workers/
COPY --from=builder /app/packages/workers/dist packages/workers/dist/
COPY --from=builder /app/config config/
COPY --from=builder /app/node_modules node_modules/

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data/uploads /data/output

CMD ["node", "packages/workers/dist/index.js"]
