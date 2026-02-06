FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/admin-ui/package.json packages/admin-ui/

RUN pnpm install --frozen-lockfile --filter admin-ui

COPY packages/admin-ui/ packages/admin-ui/

RUN pnpm --filter admin-ui run build

# ─── Production (Nginx) ────────────────────────────────────────────
FROM nginx:alpine

COPY docker/admin-ui.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/admin-ui/dist /usr/share/nginx/html

EXPOSE 80
