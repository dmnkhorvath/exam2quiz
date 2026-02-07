FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/workers/package.json packages/workers/

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN npm ci --workspace=packages/shared --workspace=packages/workers

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/workers/ packages/workers/
COPY config/ config/

RUN npx prisma generate --schema=packages/shared/prisma/schema.prisma
RUN npm run build -w packages/shared && npm run build -w packages/workers

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
