FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN pnpm install --frozen-lockfile --filter shared --filter api

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

RUN pnpm exec prisma generate --schema=packages/shared/prisma/schema.prisma
RUN pnpm --filter shared run build && pnpm --filter api run build

# ─── Production ─────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy the full pnpm workspace structure needed at runtime
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/shared/prisma packages/shared/prisma/
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules/
COPY --from=builder /app/packages/api/package.json packages/api/package.json
COPY --from=builder /app/packages/api/dist packages/api/dist/
COPY --from=builder /app/packages/api/node_modules packages/api/node_modules/

COPY docker/api-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data/uploads /data/output

EXPOSE 3000 9090
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "packages/api/dist/index.js"]
