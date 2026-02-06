#!/bin/sh
set -e

echo "[api-entrypoint] Syncing database schema..."
npx prisma db push --schema=packages/shared/prisma/schema.prisma --skip-generate --accept-data-loss

echo "[api-entrypoint] Starting API server..."
exec "$@"
