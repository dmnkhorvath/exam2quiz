# Exams2Quiz

A multi-tenant, event-driven platform for processing Hungarian medical exam PDFs into structured, categorized, and deduplicated question banks. Built as a Node.js/TypeScript monorepo with a 5-stage AI-powered pipeline, REST API, React admin dashboard, and full Docker Compose orchestration with monitoring.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Development](#local-development)
  - [Docker Deployment](#docker-deployment)
- [Pipeline Stages](#pipeline-stages)
- [API Reference](#api-reference)
- [Admin Dashboard](#admin-dashboard)
- [Multi-Tenancy](#multi-tenancy)
- [Monitoring](#monitoring)
- [Configuration](#configuration)
- [Database Schema](#database-schema)
- [Python Scripts (Legacy)](#python-scripts-legacy)
- [Development](#development)

---

## Overview

Exams2Quiz processes scanned Hungarian qualification exam PDFs through an automated pipeline:

1. **PDF Extraction** — Detects question boundaries and crops individual question images
2. **AI Parsing** — Sends images to Google Gemini for OCR and structured data extraction
3. **Categorization** — Classifies questions into 11 medical topic categories using AI
4. **Similarity Detection** — Finds duplicate/near-duplicate questions using ML embeddings
5. **Category Split** — Organizes results into per-category output files

The platform supports multiple tenants, each with their own API keys, category definitions, storage quotas, and concurrent pipeline limits.

## Architecture

```
                          ┌─────────────┐
                          │  Admin UI   │  React + Vite + DaisyUI
                          │  :8080      │  (Nginx in production)
                          └──────┬──────┘
                                 │
                          ┌──────▼──────┐
                          │  Fastify    │  REST API + JWT Auth
                          │  API :3000  │
                          └──────┬──────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
             ┌──────▼──────┐ ┌──▼───┐ ┌──────▼──────┐
             │ PostgreSQL  │ │Redis │ │  BullMQ     │
             │ :5432       │ │:6379 │ │  Workers    │
             └─────────────┘ └──────┘ └──────┬──────┘
                                             │
                    ┌────────────┬────────────┼────────────┬────────────┐
                    │            │            │            │            │
              PDF Extract  Gemini Parse  Categorize  Similarity  Category Split
                    │            │            │            │            │
                    └────────────┴────────────┴────────────┴────────────┘
                                        Event-driven pipeline
                                             │
                    ┌────────────┬────────────┘
                    │            │
             ┌──────▼──────┐ ┌──▼───────────┐
             │ Prometheus  │ │   Grafana    │
             │ :9091       │ │   :3001      │
             └─────────────┘ └──────────────┘
```

Each pipeline stage is a BullMQ worker. Stages auto-enqueue the next stage on completion, creating a fully event-driven processing chain.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+, TypeScript 5.7, ESM modules |
| **API** | Fastify 5, @fastify/jwt, @fastify/multipart |
| **Workers** | BullMQ 5 job queue on Redis 7 |
| **Database** | PostgreSQL 16 with Prisma 6.3 ORM |
| **AI/ML** | Google Gemini 2.0 Flash, @xenova/transformers (E5-small embeddings) |
| **Frontend** | React 18, React Router 7, TanStack Query 5, Tailwind CSS 3, DaisyUI 4 |
| **PDF** | mupdf (Node.js), sharp (image processing) |
| **Monitoring** | Prometheus + Grafana (auto-provisioned dashboards) |
| **Infrastructure** | Docker Compose, Nginx, multi-stage builds |

## Project Structure

```
exams2quiz/
├── packages/
│   ├── shared/              Shared types, config, Prisma DB, BullMQ queue
│   │   ├── src/
│   │   │   ├── types/       Zod schemas & TypeScript types
│   │   │   ├── config/      Environment config with Zod validation
│   │   │   ├── queue/       BullMQ job queue setup
│   │   │   └── db/          Prisma client initialization
│   │   └── prisma/
│   │       └── schema.prisma
│   ├── api/                 Fastify REST API server
│   │   └── src/
│   │       ├── routes/      auth, tenants, users, pipelines, categories
│   │       └── plugins/     JWT auth, Prometheus metrics
│   ├── workers/             BullMQ pipeline workers
│   │   └── src/
│   │       ├── stages/      pdf-extract, gemini-parse, categorize, similarity, category-split
│   │       └── metrics.ts   Worker-level Prometheus instrumentation
│   └── admin-ui/            React admin dashboard
│       └── src/
│           ├── pages/       Login, Dashboard, Tenants, Users, Pipelines, Categories
│           ├── services/    Typed API client layer
│           ├── hooks/       Auth context & useAuth hook
│           └── components/  Layout shell
├── config/
│   └── categories.json      Category definitions (single source of truth)
├── docker/
│   ├── api.Dockerfile
│   ├── workers.Dockerfile
│   ├── admin-ui.Dockerfile
│   ├── api-entrypoint.sh    Runs Prisma migrations on startup
│   ├── admin-ui.nginx.conf  SPA routing, gzip, static caching
│   ├── prometheus.yml       Scrape configuration
│   └── grafana/             Auto-provisioned datasources & dashboards
├── scripts/                 Legacy Python pipeline scripts
├── docker-compose.yml       Full 7-service orchestration
├── .env.example             Environment variable template
├── tsconfig.base.json       Shared TypeScript configuration
├── eslint.config.mjs        ESLint flat config for all packages
├── vitest.config.ts          Test configuration
└── ARCHITECTURE.md          Original architectural plan
```

## Getting Started

### Prerequisites

- **Node.js** >= 20.0.0
- **PostgreSQL** 16+
- **Redis** 7+
- **Google Gemini API key** — get one at [Google AI Studio](https://aistudio.google.com/apikey)

### Local Development

```bash
# 1. Clone and install
git clone <repo-url>
cd exams2quiz
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set DATABASE_URL, REDIS_HOST, JWT_SECRET, GEMINI_API_KEY

# 3. Set up database
npm run db:generate    # Generate Prisma client
npm run db:push        # Push schema to PostgreSQL

# 4. Start services (in separate terminals)
npm run dev:api        # API server on :3000
npm run dev:workers    # Pipeline workers
npm run dev:admin      # Admin UI on :5174
```

The first registered user automatically becomes `SUPER_ADMIN`.

### Docker Deployment

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env with production values

# 2. Build and start all services
npm run docker:build
npm run docker:up

# Or directly:
docker compose up -d --build
```

This starts 7 services:

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL | 5432 | Database |
| Redis | 6379 | Job queue & caching |
| API | 3000 | REST API |
| Workers | — | Pipeline processing |
| Admin UI | 8080 | Management dashboard |
| Prometheus | 9091 | Metrics collection |
| Grafana | 3001 | Monitoring dashboards |

The API container automatically runs Prisma migrations on startup.

## Pipeline Stages

Each stage is an independent BullMQ worker that auto-enqueues the next stage on completion.

### 1. PDF Extraction (`pdf-extract`)

Uses **mupdf** and **sharp** to scan PDF pages for question markers (`"X pont"` — Hungarian for "X points"), detect boundaries, and crop individual question images as PNGs.

**Output:** PNG images with naming convention `{exam}_q{NNN}_{N}pt.png`

### 2. Gemini Parse (`gemini-parse`)

Sends each question image to **Google Gemini 2.0 Flash** with a system prompt explaining the Hungarian exam format. Returns structured JSON with fields:

- `question_number`, `points`, `question_text`, `question_type`
- `correct_answer`, `options`
- Question types: `multiple_choice`, `fill_in`, `matching`, `open`

**Config:** Batch concurrency of 10, retry 3 with exponential backoff for rate limits. Uses tenant-specific Gemini API key with environment fallback.

### 3. Categorization (`categorize`)

Classifies each question into one of the categories defined in `config/categories.json` using Gemini. Categories are dynamically loaded — no hardcoded values.

**Default categories:** 11 Hungarian medical topics (anatomy, cardiovascular, respiratory, nervous system, etc.)

### 4. Similarity Detection (`similarity`)

Detects duplicate and near-duplicate questions using a two-stage ML pipeline:

1. **Embedding:** Encodes question text with `multilingual-e5-small` (ONNX via @xenova/transformers)
2. **Clustering:** Density-based clustering (simplified HDBSCAN) with mutual reachability distance
3. **Verification:** Optional cross-encoder verification via `ms-marco-MiniLM-L-6-v2`
4. **Refinement:** Large clusters are split using stricter thresholds

**Output:** `similarity_group_id` assigned to each question

### 5. Category Split (`category-split`)

Groups questions by category and similarity group, produces per-category output files with Hungarian transliteration for filenames. Marks the `PipelineRun` as `COMPLETED`.

## API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Current user profile |

### Tenants (SUPER_ADMIN only)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tenants` | List all tenants |
| GET | `/api/tenants/:id` | Get tenant details |
| POST | `/api/tenants` | Create tenant |
| PUT | `/api/tenants/:id` | Update tenant |
| DELETE | `/api/tenants/:id` | Soft delete tenant |

### Users (Admin-scoped)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List users for tenant |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Soft delete user |

### Pipelines

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/pipelines` | List pipeline runs |
| POST | `/api/pipelines` | Upload PDF & start pipeline |
| GET | `/api/pipelines/:id` | Pipeline run detail |
| DELETE | `/api/pipelines/:id` | Cancel pipeline run |

PDF upload supports files up to 100MB via multipart form data.

### Categories (Tenant-scoped)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/categories` | List categories |
| POST | `/api/categories` | Create category |
| PUT | `/api/categories/:id` | Update category |
| DELETE | `/api/categories/:id` | Delete category |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Liveness check |
| GET | `/ready` | Readiness check |

## Admin Dashboard

The React admin dashboard provides:

- **Login** — JWT-based authentication
- **Dashboard** — Overview stats (tenants, users, pipelines) with recent pipeline activity
- **Tenants** — CRUD management (SUPER_ADMIN only) with API key and quota configuration
- **Users** — Per-tenant user management with role assignment
- **Pipelines** — Upload PDFs, monitor pipeline progress with 5-second auto-refresh, view stage details
- **Categories** — Per-tenant category CRUD

Role-based access control via `RequireAuth` and `RequireRole` route guards.

## Multi-Tenancy

Each tenant gets:

- **Isolated data** — Pipeline runs, users, and categories are scoped to tenant
- **Own Gemini API key** — Per-tenant key with environment fallback
- **Configurable limits** — Max concurrent pipelines (default: 2), storage quota (default: 5GB)
- **Custom categories** — Each tenant can define their own question categories

### User Roles

| Role | Permissions |
|------|-------------|
| `SUPER_ADMIN` | Full access, manage tenants, cross-tenant visibility |
| `TENANT_ADMIN` | Manage users and settings within their tenant |
| `TENANT_USER` | Run pipelines and view results within their tenant |

## Monitoring

### Prometheus Metrics

The API and workers expose Prometheus metrics:

**API metrics** (port 9090):
- `http_requests_total` — Request count by method, route, status
- `http_request_duration_seconds` — Request latency histogram
- `pipelines_started_total` — Pipeline creation count

**Worker metrics** (port 9092):
- `worker_jobs_completed_total` — Completed jobs by stage
- `worker_jobs_failed_total` — Failed jobs by stage
- `worker_job_duration_seconds` — Job processing time by stage
- `worker_active_jobs` — Currently active jobs gauge

### Grafana Dashboard

Auto-provisioned Grafana dashboard with 8 panels covering request rates, latencies, pipeline throughput, and worker health. Access at `http://localhost:3001` (default credentials: `admin` / value of `GRAFANA_PASSWORD`).

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | _(empty)_ | Redis password |
| `API_PORT` | `3000` | API server port |
| `JWT_SECRET` | `change-me-in-production` | JWT signing secret |
| `WORKER_CONCURRENCY` | `3` | Workers per stage |
| `WORKER_REPLICAS` | `1` | Worker container replicas |
| `GEMINI_API_KEY` | — | Google Gemini API key (fallback) |
| `UPLOAD_DIR` | `/data/uploads` | PDF upload directory |
| `OUTPUT_DIR` | `/data/output` | Pipeline output directory |
| `METRICS_PORT` | `9090` | Prometheus metrics port |
| `ADMIN_PORT` | `8080` | Admin UI port |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Logging level |

### Category Configuration

Categories are defined in `config/categories.json` — the single source of truth for the pipeline:

```json
[
  {
    "key": "KERINGES",
    "name": "Keringés",
    "file": "keringes.json"
  }
]
```

Each entry has a `key` (internal identifier), `name` (display name), and `file` (output filename). Add or remove categories by editing this file — no code changes required.

## Database Schema

The PostgreSQL schema (managed by Prisma) includes:

| Model | Purpose |
|-------|---------|
| `Tenant` | Multi-tenant organizations with API keys, quotas, limits |
| `User` | Users with roles (SUPER_ADMIN, TENANT_ADMIN, TENANT_USER) |
| `TenantCategory` | Per-tenant category definitions |
| `PipelineRun` | Pipeline execution tracking (QUEUED → RUNNING → COMPLETED/FAILED) |
| `PipelineJob` | Per-stage job tracking with progress, attempts, and results |

Run migrations with `npm run db:migrate` or `npm run db:push` for development.

## Python Scripts (Legacy)

The `scripts/` directory contains the original standalone Python pipeline that predates the Node.js implementation. These scripts can still be used for batch processing outside the platform.

See [scripts/README.md](scripts/README.md) for detailed usage and [scripts/SIMILARITY_GUIDE.md](scripts/SIMILARITY_GUIDE.md) for the similarity algorithm documentation.

## Development

### Available Scripts

```bash
npm run build            # Build all packages
npm run dev:api          # Start API in dev mode (tsx watch)
npm run dev:workers      # Start workers in dev mode
npm run dev:admin        # Start admin UI (Vite dev server)
npm run lint             # Lint all TypeScript files
npm run typecheck        # Type-check all packages
npm run test             # Run tests (Vitest)
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage
npm run db:generate      # Generate Prisma client
npm run db:migrate       # Run Prisma migrations
npm run db:push          # Push schema to database
npm run docker:up        # Start Docker Compose
npm run docker:down      # Stop Docker Compose
npm run docker:build     # Build Docker images
npm run audit            # Security audit
npm run complexity       # Check code complexity (ESLint)
npm run duplication      # Check code duplication (jscpd)
```

### Workspace Packages

| Package | Description |
|---------|-------------|
| `@exams2quiz/shared` | Types, config, DB client, job queue (library) |
| `@exams2quiz/api` | Fastify REST API server |
| `@exams2quiz/workers` | BullMQ pipeline workers (5 stages) |
| `@exams2quiz/admin-ui` | React admin dashboard (Vite + DaisyUI) |

### Docker Networks

| Network | Services | Purpose |
|---------|----------|---------|
| `frontend` | Admin UI, Grafana | Public-facing services |
| `backend` | PostgreSQL, Redis, API, Workers | Internal services |
| `monitoring` | Prometheus, Grafana, API, Workers | Metrics collection |
