FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/admin-ui/package.json packages/admin-ui/

RUN npm ci --workspace=packages/admin-ui

COPY packages/admin-ui/ packages/admin-ui/

RUN npm run build -w packages/admin-ui

# ─── Production (Nginx) ────────────────────────────────────────────
FROM nginx:alpine

COPY docker/admin-ui.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/packages/admin-ui/dist /usr/share/nginx/html

EXPOSE 80
