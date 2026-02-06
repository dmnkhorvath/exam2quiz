#!/bin/sh
set -e

echo "[api-entrypoint] Running Prisma migrations..."
npx prisma migrate deploy --schema=packages/shared/prisma/schema.prisma 2>/dev/null || \
  npx prisma db push --schema=packages/shared/prisma/schema.prisma --accept-data-loss 2>/dev/null || \
  echo "[api-entrypoint] Warning: DB migration skipped (no migrations dir yet)"

echo "[api-entrypoint] Starting API server..."
exec "$@"
