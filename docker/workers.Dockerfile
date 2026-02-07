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

# Copy the full pnpm workspace structure needed at runtime
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/shared/prisma packages/shared/prisma/
COPY --from=builder /app/packages/shared/node_modules packages/shared/node_modules/
COPY --from=builder /app/packages/workers/package.json packages/workers/package.json
COPY --from=builder /app/packages/workers/dist packages/workers/dist/
COPY --from=builder /app/packages/workers/node_modules packages/workers/node_modules/
COPY --from=builder /app/config config/

# Install Python + uv + build tools for the similarity worker subprocess
RUN apt-get update -y \
    && apt-get install -y openssl python3 python3-dev build-essential curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Copy Python scripts and pre-install dependencies at build time
COPY scripts/ scripts/
RUN uv run --script scripts/find_similar_questions.py --help

RUN mkdir -p /data/uploads /data/output

CMD ["node", "packages/workers/dist/index.js"]
