FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/

RUN npm ci --workspace=packages/shared --workspace=packages/api

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

RUN npm run build -w packages/shared && npm run build -w packages/api

# ─── Production ─────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/shared/prisma packages/shared/prisma/
COPY --from=builder /app/packages/api/package.json packages/api/
COPY --from=builder /app/packages/api/dist packages/api/dist/
COPY --from=builder /app/node_modules node_modules/

RUN mkdir -p /data/uploads /data/output

EXPOSE 3000 9090
CMD ["node", "packages/api/dist/index.js"]
