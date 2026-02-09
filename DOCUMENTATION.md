# Exams2Quiz System Documentation

A multi-tenant pipeline system that processes Hungarian exam PDFs into structured, categorized quiz question banks. The system extracts questions from scanned PDFs using computer vision, parses them with Google Gemini AI, categorizes by topic, detects duplicates via similarity analysis, and serves the results through both an admin dashboard and public guest pages.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Pipeline Stages](#3-pipeline-stages)
4. [Batch Processing](#4-batch-processing)
5. [Manual Similarity Workflow](#5-manual-similarity-workflow)
6. [API Reference](#6-api-reference)
7. [Authentication & Multi-Tenancy](#7-authentication--multi-tenancy)
8. [Worker Processes](#8-worker-processes)
9. [Admin UI](#9-admin-ui)
10. [Public Guest Routes](#10-public-guest-routes)
11. [Infrastructure](#11-infrastructure)
12. [Configuration Reference](#12-configuration-reference)

---

## 1. System Overview

### Purpose

Exams2Quiz automates the conversion of Hungarian exam PDFs (scanned documents with red-text answers) into structured, searchable, and categorized quiz question banks. It handles the full lifecycle: PDF ingestion, question extraction, AI-powered parsing, topic categorization, duplicate detection, and public quiz serving.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 22 (API + Workers), Python 3.11 (similarity) |
| **API Framework** | Fastify 5 with JWT, CORS, Multipart, Swagger |
| **Database** | PostgreSQL 16 with Prisma ORM |
| **Message Broker** | Apache Kafka (Confluent 7.5) via KafkaJS |
| **Cache** | Redis 7 (queue backend + separate HTML cache instance) |
| **AI** | Google Gemini (`gemini-3-flash-preview`) for parsing and categorization |
| **PDF Processing** | MuPDF (extraction), Sharp (image cropping) |
| **Similarity** | Python: sentence-transformers (E5 embeddings), HDBSCAN, cross-encoder |
| **Admin UI** | React 18, TanStack Query, React Router, Tailwind CSS, DaisyUI |
| **Monitoring** | Prometheus, Grafana, Loki, Promtail |
| **Container** | Docker Compose (11 services) |
| **Package Manager** | pnpm 10 (workspace monorepo) |

### Monorepo Layout

```
exams2quiz/
├── packages/
│   ├── shared/          # Types, DB client, Kafka queue wrapper, config
│   ├── api/             # Fastify REST API + public SSR routes
│   ├── workers/         # Kafka consumers for pipeline stages
│   └── admin-ui/        # React admin dashboard (Vite build)
├── scripts/             # Python similarity scripts
├── config/              # Default category definitions
├── docker/              # Dockerfiles, Prometheus/Grafana/Loki configs
├── prisma/              # Database schema and migrations
└── docker-compose.yml   # Full stack orchestration
```

---

## 2. Architecture

### High-Level Data Flow

```mermaid
graph TD
    subgraph Ingestion
        A[PDF Upload / URL Download] --> B[API Server]
    end

    subgraph Pipeline Workers via Kafka
        B -->|exams2quiz-pdf-extract| C[pdf-extract]
        C -->|exams2quiz-gemini-parse| D[gemini-parse]
        D -->|exams2quiz-categorize| E[categorize]
        E -->|PAUSE or batch-complete| F{Route Decision}
        F -->|Standalone| G[PAUSED - Manual Similarity]
        F -->|Batch Child| H[COMPLETED - Await Coordinator]
        G -->|User uploads result| I[category-split]
        H -->|All children done| J[batch-coordinate]
        J -->|exams2quiz-similarity| K[similarity]
        K -->|exams2quiz-category-split| I
    end

    subgraph Storage
        C -->|PNG images| FS[(Filesystem)]
        D -->|parsed.json| FS
        E -->|categorized.json| FS
        K -->|similarity.json| FS
        I -->|split/*.json| FS
        E -->|Questions| DB[(PostgreSQL)]
    end

    subgraph Serving
        DB --> L[Admin UI]
        FS --> M[Public Guest Pages]
        M -->|Cached HTML| R[(Redis Cache)]
    end
```

### Request Flow

1. **Upload**: User uploads PDFs or provides URLs via the admin UI
2. **API**: Validates tenant, enforces quotas, stores files, enqueues first Kafka message
3. **Workers**: Each stage consumes from its Kafka topic, processes, and produces to the next
4. **Database**: Questions are upserted into a tenant-wide pool during categorization
5. **Output**: Split JSON files are served via the admin UI and public guest pages

---

## 3. Pipeline Stages

The pipeline processes exam PDFs through 5 sequential stages (plus a batch coordinator for large uploads). Each stage runs as a Kafka consumer with its own topic and consumer group.

### Stage 1: pdf-extract

**Topic**: `exams2quiz-pdf-extract` | **Input**: PDF file paths | **Output**: Cropped PNG images

Extracts individual questions from scanned exam PDFs by detecting "pont" (Hungarian for "points") markers.

**Processing**:
1. Opens each PDF with MuPDF
2. Searches each page for `\b(\d+)\s*pont\b` patterns in the right half of the page
3. Filters false positives (e.g., "adható", "válaszonként")
4. Calculates crop regions between consecutive question markers
5. Renders the page at target DPI (default 150) and crops each question region
6. Saves as `{pdfStem}_q{NNN}_{points}pt.png`
7. Generates a `manifest.json` per PDF

**Output files**: `{OUTPUT_DIR}/{tenantId}/{runId}/{pdfStem}/*.png`

### Stage 2: gemini-parse

**Topic**: `exams2quiz-gemini-parse` | **Input**: Image paths | **Output**: Structured JSON

Sends cropped question images to Google Gemini for OCR and structured extraction.

**Processing**:
1. Processes images in parallel (concurrency limit: 10)
2. Each image sent to Gemini with a system prompt specifying Hungarian medical exam format
3. Gemini returns structured JSON: `{question_number, points, question_text, question_type, correct_answer, options}`
4. Retries on rate limit (429) with exponential backoff, JSON parse errors, and other API failures (max 3 retries)
5. Merges all results into a single output file

**Output files**: `{OUTPUT_DIR}/{tenantId}/{runId}/parsed.json`

### Stage 3: categorize

**Topic**: `exams2quiz-categorize` | **Input**: Parsed questions | **Output**: Categorized questions

Classifies each question into tenant-defined categories and optional subcategories using Gemini.

**Processing**:
1. Loads tenant category definitions from the database
2. Builds a dynamic Gemini prompt listing all available categories/subcategories
3. Processes questions in parallel (concurrency limit: 10)
4. Each question's text and answer sent to Gemini, which returns `{category, subcategory?, reasoning}`
5. Validates returned categories against the allowed list (with fuzzy matching)
6. Upserts all questions into the tenant-wide `Question` table (serializable transaction, 100-question chunks)
7. Writes both run-specific and tenant-merged categorized files

**Routing after completion**:
- **Standalone runs**: Pipeline status set to `PAUSED` at `MANUAL_SIMILARITY_UPLOAD` stage
- **Batch child runs**: Status set to `COMPLETED` (coordinator handles next steps)

**Output files**: `{OUTPUT_DIR}/{tenantId}/{runId}/categorized.json` and `categorized_merged.json`

### Stage 4: similarity

**Topic**: `exams2quiz-similarity` | **Input**: Merged categorized questions | **Output**: Similarity groups

Detects duplicate and near-duplicate questions using AI embeddings and cross-encoder verification.

**Processing**:
1. Cleans any pre-existing output files
2. Spawns Python subprocess: `scripts/find_similar_questions.py`
3. Python script performs two-stage clustering:
   - **Stage 1**: E5 multilingual embeddings + HDBSCAN clustering
   - **Stage 2**: Cross-encoder verification to refine clusters
4. Each question receives a `similarity_group_id` (questions in the same group are duplicates)
5. Timeout: 60 minutes, max buffer: 100MB

**Output files**: `{OUTPUT_DIR}/{tenantId}/{runId}/similarity.json`

### Stage 5: category-split

**Topic**: `exams2quiz-category-split` | **Input**: Similarity-annotated questions | **Output**: Per-category JSON files

Splits the question pool into separate files by category/subcategory, grouped by similarity.

**Processing**:
1. Groups questions by subcategory (if present) or category
2. For each group:
   - Sanitizes the name to a filesystem-safe filename (Hungarian transliteration)
   - Groups questions by `similarity_group_id` (null = unique question)
   - Writes JSON with structure: `{category_name, subcategory_name?, groups: [[q1, q2], [q3], ...]}`
3. Persists `similarityGroupId` back to the database for each question
4. Marks the pipeline as `COMPLETED`

**Output files**: `{OUTPUT_DIR}/{tenantId}/{runId}/split/{category}.json`

### Stage 6: batch-coordinate

**Topic**: `exams2quiz-batch-coordinate` | **Input**: Parent + child run IDs | **Output**: Merged dataset

Coordinates batch processing by polling child runs and triggering post-merge stages.

See [Batch Processing](#4-batch-processing) for details.

---

## 4. Batch Processing

When a pipeline upload contains more than `BATCH_SIZE` PDFs (default: 10), the system automatically splits it into parallel batches.

### Fan-Out (API)

1. API creates a **parent** `PipelineRun` with `totalBatches`, `batchSize`
2. PDFs are distributed across **child** `PipelineRun` records (max 20 batches)
3. Each child receives a subset of PDFs in its own upload directory
4. Child runs are enqueued independently on `exams2quiz-pdf-extract`
5. Parent run is enqueued on `exams2quiz-batch-coordinate`

### Parallel Processing (Children)

Each child run processes independently through stages 1-3:
- `pdf-extract` → `gemini-parse` → `categorize`
- Children complete after categorize (no similarity stage)
- All children share the same tenant question pool via database upserts

### Fan-In (Coordinator)

The `batch-coordinate` worker on the parent run:
1. Polls child run statuses every 10 seconds
2. Waits for all children to reach `COMPLETED` status
3. If any child fails: parent is marked `FAILED` immediately
4. Timeout: 4 hours maximum
5. On success: loads all tenant questions from DB, writes `categorized_merged.json`
6. Enqueues `similarity` stage on the parent run
7. Pipeline continues: `similarity` → `category-split` → `COMPLETED`

### Visibility

- Child runs are hidden from the main pipeline list (`parentRunId: null` filter)
- Parent run detail view shows expandable child list with per-batch progress
- Pipeline restart on a parent deletes and recreates all children

---

## 5. Manual Similarity Workflow

For standalone (non-batch) pipelines, the similarity stage requires manual intervention because the Python similarity script needs significant compute resources.

### Flow

1. Pipeline completes categorization and pauses at `MANUAL_SIMILARITY_UPLOAD`
2. User downloads `categorized_merged.json` via the admin UI detail modal
3. User runs the similarity script externally (or uses a hosted service)
4. User submits the similarity result URL back to the API
5. API downloads the result, validates it, writes `similarity.json`
6. Pipeline resumes with `category-split` stage

### API Endpoints

- `GET /api/pipelines/:id/categorized` — Download the merged categorized JSON (uses query token auth for direct browser downloads)
- `POST /api/pipelines/:id/similarity-url` — Submit a URL containing the similarity result JSON

### Admin UI

The pipeline detail modal shows manual similarity controls when the pipeline is paused:
- **Download Categorized JSON** button (opens in new tab)
- **Similarity Result URL** text input with Submit button

---

## 6. API Reference

The API runs on Fastify 5 at port 3000 (configurable via `API_PORT`). All `/api/*` routes require JWT authentication unless noted.

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | None | Login with email/password, returns JWT |
| `POST` | `/api/auth/register` | None (first user) / SUPER_ADMIN | Register new user |
| `GET` | `/api/auth/me` | JWT | Get current user profile |

### Tenants (SUPER_ADMIN only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tenants` | List all tenants with user/pipeline counts |
| `POST` | `/api/tenants` | Create tenant (slug must be `^[a-z0-9-]+$`) |
| `GET` | `/api/tenants/:id` | Get tenant details |
| `PUT` | `/api/tenants/:id` | Update tenant settings |
| `DELETE` | `/api/tenants/:id` | Deactivate tenant (soft delete) |

### Users (SUPER_ADMIN / TENANT_ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List users (scoped by role) |
| `POST` | `/api/users` | Create user (TENANT_ADMIN limited to own tenant) |
| `PUT` | `/api/users/:id` | Update user (role/tenantId changes: SUPER_ADMIN only) |
| `DELETE` | `/api/users/:id` | Deactivate user (soft delete) |

### Pipelines

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pipelines` | JWT | Upload PDFs/URLs, start pipeline (multipart/form-data) |
| `GET` | `/api/pipelines` | JWT | List pipelines (filter: `?status=X&tenantId=Y&limit=N&offset=N`) |
| `GET` | `/api/pipelines/:id` | JWT | Get pipeline detail with jobs and child runs |
| `DELETE` | `/api/pipelines/:id` | JWT | Cancel active pipeline (soft) |
| `DELETE` | `/api/pipelines/:id/delete` | JWT | Permanently delete terminal pipeline |
| `POST` | `/api/pipelines/:id/restart` | JWT | Restart terminal pipeline from pdf-extract |
| `GET` | `/api/pipelines/:id/categorized` | JWT / `?token=` | Download categorized JSON (paused pipelines) |
| `POST` | `/api/pipelines/:id/similarity-url` | JWT | Submit similarity result URL, resume pipeline |
| `GET` | `/api/pipelines/:id/splits` | JWT | List available split files |
| `GET` | `/api/pipelines/:id/splits/:filename` | JWT | Download specific split file |
| `POST` | `/api/pipelines/merge` | JWT | Merge multiple completed pipelines |

### Categories

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/categories` | List categories (`?tenantId=` for SUPER_ADMIN) |
| `POST` | `/api/categories` | Create category with optional subcategory |
| `PUT` | `/api/categories/:id` | Update category fields |
| `DELETE` | `/api/categories/:id` | Delete category (hard delete) |

### Questions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/questions` | JWT | List questions (filter: `?pipelineRunId=&category=&subcategory=&tenantId=`) |
| `GET` | `/api/questions/flagged` | JWT | List questions marked as wrong |
| `POST` | `/api/questions/:id/reparse` | JWT | Re-extract question via Gemini from source image |
| `POST` | `/api/questions/:id/recategorize` | JWT | Re-categorize question via Gemini |
| `PATCH` | `/api/questions/:id` | JWT | Manually edit question data/categorization |
| `GET` | `/api/questions/:id/image` | JWT / `?token=` | Serve question source image |
| `POST` | `/api/questions/:id/resolve` | JWT | Clear "marked wrong" flag |

### Tenant Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tenant/settings` | Get tenant settings (API key masked) |
| `PUT` | `/api/tenant/settings` | Update Gemini API key |

### Public Guest Routes (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:slug` | Tenant category listing page |
| `GET` | `/:slug/:categoryKey` | Subcategory listing page |
| `GET` | `/:slug/:categoryKey/:subcategoryKey` | Question cards with search, answers, reporting |
| `POST` | `/:slug/mark-wrong` | Flag a question as incorrect (invalidates cache) |

### Health & Metrics

| Method | Path | Port | Description |
|--------|------|------|-------------|
| `GET` | `/health` | 3000 | API health check |
| `GET` | `/ready` | 3000 | Readiness probe |
| `GET` | `/metrics` | 9090 | Prometheus metrics scrape endpoint |

---

## 7. Authentication & Multi-Tenancy

### JWT Authentication

- Tokens are issued on login with 24-hour expiry
- Payload: `{sub: userId, email, role, tenantId}`
- Passed via `Authorization: Bearer <token>` header
- Special: Download endpoints accept `?token=<jwt>` query parameter for `<a>` tag and `<img>` tag compatibility

### Roles

| Role | Scope | Capabilities |
|------|-------|-------------|
| `SUPER_ADMIN` | Cross-tenant | All operations, tenant management, can act on any tenant via `?tenantId=` param |
| `TENANT_ADMIN` | Own tenant | User management within tenant, settings, all pipeline operations |
| `TENANT_USER` | Own tenant | Pipeline operations, categories, questions, settings |

### Multi-Tenancy Model

- All data is scoped by `tenantId` foreign keys
- SUPER_ADMIN users have nullable `tenantId` and can access any tenant
- TENANT_ADMIN and TENANT_USER are strictly scoped to their tenant
- Cross-tenant access attempts return 404 (not 403) to avoid leaking tenant existence
- Per-tenant configuration: Gemini API key, max concurrent pipelines, storage quota

### Field Name Convention

The Prisma schema uses `errorMessage` for error fields, while the admin UI TypeScript interfaces use `error`. The API layer maps between them:

```typescript
const { errorMessage, ...rest } = pipelineRun;
return { ...rest, error: errorMessage ?? null };
```

---

## 8. Worker Processes

### Kafka Architecture

Workers consume from dedicated Kafka topics, one per pipeline stage. The shared queue module (`@exams2quiz/shared/queue`) abstracts Kafka operations behind a BullMQ-compatible interface.

**Topic naming**: `exams2quiz-{stage}` (e.g., `exams2quiz-pdf-extract`)

**Consumer groups**: `exams2quiz-{stage}-group` (enables load balancing across replicas)

**Message flow**:
```
Producer (API/Worker) → Kafka Topic → Consumer Group → Worker Handler
```

### Worker Registration

All workers are registered in `packages/workers/src/index.ts`:

```typescript
// Each worker is a Kafka consumer subscribed to its stage topic
createWorker(PipelineStage.PDF_EXTRACT, processPdfExtract);
createWorker(PipelineStage.GEMINI_PARSE, processGeminiParse);
createWorker(PipelineStage.CATEGORIZE, processCategorize);
createWorker(PipelineStage.SIMILARITY, processSimilarity);
createWorker(PipelineStage.CATEGORY_SPLIT, processCategorySplit);
createWorker(PipelineStage.BATCH_COORDINATE, processBatchCoordinate);
```

### Error Handling Pattern

All 6 workers follow an identical error handling pattern:

```typescript
catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);

  // Mark the specific job as failed
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: currentStage },
    data: { status: "FAILED", errorMessage: errorMsg },
  });

  // Mark the entire pipeline run as failed
  await db.pipelineRun.update({
    where: { id: pipelineRunId },
    data: { status: "FAILED", errorMessage: errorMsg },
  });

  throw err; // Triggers Kafka retry (doesn't commit offset)
}
```

### Structured Logging

Workers emit structured log events parsed by Promtail:

```
[pdf-extract] [INFO] job_started: Processing 5 PDFs {"tenantId":"abc","pipelineRunId":"xyz"}
```

Format: `[stage] [LEVEL] event_name: message {json_metadata}`

### Prometheus Metrics

Workers expose metrics on port 9090:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `pipeline_stage_events_total` | Counter | stage, level, event | Stage event counts |
| `pipeline_questions_processed_total` | Counter | stage, status | Questions processed per stage |
| `pipeline_gemini_api_calls_total` | Counter | stage, status | Gemini API call outcomes |
| `pipeline_runs_completed_total` | Counter | status | Pipeline completion counts |
| `pipeline_questions_per_category_total` | Counter | category | Questions per category |
| `pipeline_similarity_groups_total` | Counter | — | Similarity groups created |

---

## 9. Admin UI

The admin dashboard is a React 18 SPA built with Vite, using TanStack Query for server state management and DaisyUI for component styling.

### Dashboard

![Dashboard](docs/screenshots/dashboard-page.png)

The dashboard shows summary statistics (total/completed/failed pipelines, tenant and user counts for admins) and a table of the 10 most recent pipeline runs with status badges.

### Pipelines Page

![Pipelines](docs/screenshots/pipelines-page.png)

The pipelines page is the primary workspace:

- **Tenant selector** (SUPER_ADMIN): Switch between tenants
- **Upload form**: Drag-and-drop PDFs or paste URLs (one per line)
- **Status filter buttons**: ALL, QUEUED, PROCESSING, PAUSED, COMPLETED, FAILED, CANCELLED
- **Pipeline table**: ID, files, status badge, current stage, progress bar, error, timestamps, actions
- **Actions per pipeline**: Detail modal, Cancel (active), Restart (terminal), Delete (terminal)
- **Merge feature**: Select multiple COMPLETED pipelines to merge into a new pipeline
- **Detail modal**: Full metadata, job progress, batch children (expandable), manual similarity controls when paused
- **Auto-refresh**: Active pipelines poll every 5 seconds

### Categories Page

![Categories](docs/screenshots/categories-page.png)

Categories are grouped by name with expandable subcategory rows:

- **Create**: Name, key, output file, sort order, with multi-subcategory tag input
- **Edit**: Inline editing of individual category/subcategory rows
- **Add Subcategory**: Add new subcategories to existing category groups
- **Delete**: Remove individual categories or subcategories
- Auto-generated keys and filenames from base category

### Questions Page

![Questions](docs/screenshots/questions-page.png)

Browse processed questions by completed pipeline run:

- **Pipeline selector**: Dropdown of completed runs
- **Split file tabs**: Horizontal tabs for each category file
- **JSON viewer**: Prettified JSON display of the split file contents with category/subcategory metadata

### Flagged Questions Page

![Flagged Questions](docs/screenshots/flagged-page.png)

Review and fix questions reported as incorrect by users:

- **Question cards**: Error-bordered cards showing question text, answer, category, file, and flagged date
- **Image preview**: Hover over filename badges for PNG/JPG files to see the source image
- **Re-parse**: Send the source image back to Gemini for fresh extraction
- **Re-categorize**: Send the question back to Gemini for fresh categorization
- **Edit**: Manually edit question text, answer, category, and subcategory
- **Resolve**: Clear the "marked wrong" flag

### Settings Page

![Settings](docs/screenshots/settings-page.png)

Tenant-scoped settings:

- **Theme**: System/Light/Dark mode toggle (persisted to localStorage)
- **Tenant info**: Name and slug (read-only)
- **Gemini API Key**: View masked key, edit, or remove

---

## 10. Public Guest Routes

The public pages serve exam questions to unauthenticated users via server-side rendered HTML. No React — pure HTML with DaisyUI/Tailwind CSS loaded from CDN.

### Tenant Index (`/:slug`)

![Public Tenant Page](docs/screenshots/public-tenant-page.png)

Lists all categories and subcategories for a tenant as clickable cards with expandable subcategory links.

### Question Cards (`/:slug/:categoryKey/:subcategoryKey`)

![Public Questions](docs/screenshots/public-questions-page.png)

Displays question cards for a specific subcategory:

- **Search**: Sticky search bar with debounced filtering (300ms)
- **Question type badges**: Multiple Choice (info), True/False (accent), Open (ghost)
- **Points badge**: Shows point value
- **Duplicate count**: Warning badge showing how many similar questions exist in the group
- **Show/Hide Answer**: Toggle button to reveal the correct answer
- **Report Wrong**: Button to flag incorrect questions (no auth required)
- **Reported badge**: Questions flagged by users show an error badge and border
- **Similarity grouping**: Shows the "best" representative from each duplicate group (longest text with answer)
- **Markdown rendering**: Converts pipe tables to HTML tables, renders formatted content

### Caching

Public pages are cached in a dedicated Redis instance (`redis-cache` on port 6380):

- **Cache key pattern**: `public:tenant:{slug}`, `public:category:{slug}:{key}`, `public:questions:{slug}:{key}:{subkey}`
- **TTL**: Configurable via `CACHE_TTL_SECONDS` (default: 300)
- **Eviction**: `allkeys-lru` policy (separate from queue Redis)
- **Invalidation**: All question caches for a tenant are cleared when a question is marked wrong
- **Cache badge**: Each cached page shows a "Cached since {time}" badge with localized timestamp

### Dark Mode

Public pages support dark mode via DaisyUI's theme system:
- Inline script in `<head>` reads `localStorage('theme')` before render (prevents FOUC)
- Falls back to `prefers-color-scheme` media query
- Toggle button with sun/moon SVG icons in the navbar
- Theme persisted to `localStorage` on toggle

---

## 11. Infrastructure

### Docker Services (11)

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌─────────────┐               │
│  │ admin-ui │  │   api    │  │   workers   │  Application   │
│  │  :8080   │  │  :3000   │  │  (replicas) │               │
│  └────┬─────┘  └────┬─────┘  └──────┬──────┘               │
│       │              │               │                       │
│  ┌────┴──────────────┴───────────────┴──────┐               │
│  │              Backend Network              │               │
│  ├──────────┬───────────┬───────────┬───────┤               │
│  │ postgres │   redis   │redis-cache│ kafka │  Infrastructure│
│  │  :5432   │   :6379   │  :6380   │ :9092 │               │
│  └──────────┘───────────┘──────────┘───┬────┘               │
│                                     zookeeper                │
│                                      :2181                   │
│                                                              │
│  ┌──────────────────────────────────────────┐               │
│  │           Monitoring Network              │               │
│  ├────────────┬──────────┬─────────┬────────┤               │
│  │ prometheus │   loki   │promtail │grafana │  Monitoring    │
│  │   :9091    │  :3100   │         │ :3001  │               │
│  └────────────┘──────────┘─────────┘────────┘               │
└─────────────────────────────────────────────────────────────┘
```

| # | Service | Image | Port | Role |
|---|---------|-------|------|------|
| 1 | **postgres** | `postgres:16-alpine` | 5432 | Primary datastore (tenants, users, pipelines, questions) |
| 2 | **redis** | `redis:7-alpine` | 6379 | Queue backend (256MB, noeviction) |
| 3 | **redis-cache** | `redis:7-alpine` | 6380 | HTML page cache (128MB, allkeys-lru) |
| 4 | **zookeeper** | `cp-zookeeper:7.5.0` | 2181 | Kafka cluster coordination |
| 5 | **kafka** | `cp-kafka:7.5.0` | 9092 | Message broker for pipeline stages |
| 6 | **api** | Node.js 20 Alpine | 3000 + 9090 | REST API, file uploads, SSR public pages |
| 7 | **workers** | Node.js 20 + Python | 9090 | Kafka consumers, Gemini AI, similarity |
| 8 | **admin-ui** | Nginx Alpine | 8080 | React SPA (static files) |
| 9 | **prometheus** | `prom/prometheus:v3.2.0` | 9091 | Metrics collection (scrapes API + workers every 15s) |
| 10 | **loki** | `grafana/loki:3.3.2` | 3100 | Log aggregation (TSDB, 7-day retention) |
| 11 | **promtail** | `grafana/promtail:3.3.2` | — | Docker log scraper with structured parsing |
| 12 | **grafana** | `grafana/grafana:11.5.1` | 3001 | Dashboards and visualization |

### Networks

- **frontend**: admin-ui, api, grafana (user-facing)
- **backend**: postgres, redis, redis-cache, kafka, zookeeper, api, workers
- **monitoring**: prometheus, loki, promtail, grafana, api, workers

### Shared Volumes

- `upload-data` — Uploaded PDFs (shared: api + workers)
- `output-data` — Pipeline outputs (shared: api + workers)
- `postgres-data`, `redis-data`, `prometheus-data`, `grafana-data`, `loki-data` — Service persistence

### Monitoring Stack

**Prometheus** scrapes metrics from API and workers every 15 seconds:
- API metrics: HTTP request counts/durations, pipeline starts, file downloads
- Worker metrics: Stage events, question processing, Gemini calls, pipeline completions

**Promtail** scrapes Docker container logs via Unix socket and parses structured worker logs:
- Extracts labels: `pipeline_stage`, `log_level`, `event_name`, `tenant_id`, `pipeline_run_id`
- Forwards to Loki for querying in Grafana

**Grafana** ships with two pre-provisioned dashboards:
- **System Overview**: API throughput, worker processing rates, error counts
- **Pipeline Real-time**: Per-pipeline stage progress, duration histograms

---

## 12. Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://exams2quiz:exams2quiz@localhost:5432/exams2quiz` | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis host (queue backend) |
| `REDIS_PORT` | `6379` | Redis port |
| `CACHE_REDIS_HOST` | `localhost` | Cache Redis host |
| `CACHE_REDIS_PORT` | `6380` | Cache Redis port |
| `CACHE_TTL_SECONDS` | `300` | Public page cache TTL |
| `KAFKA_BROKER` | `localhost:9092` | Kafka broker address |
| `API_PORT` | `3000` | API server port |
| `JWT_SECRET` | `change-me-in-production` | JWT signing secret |
| `WORKER_CONCURRENCY` | `3` | Kafka consumer concurrency |
| `WORKER_REPLICAS` | `1` | Docker Compose worker replicas |
| `GEMINI_API_KEY` | — | Default Google Gemini API key |
| `UPLOAD_DIR` | `/data/uploads` | PDF upload storage path |
| `OUTPUT_DIR` | `/data/output` | Pipeline output storage path |
| `METRICS_PORT` | `9090` | Prometheus metrics endpoint port |
| `NODE_ENV` | `development` | Environment mode |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |

### Docker Compose Port Overrides

| Variable | Default | Maps To |
|----------|---------|---------|
| `POSTGRES_PORT` | `5432` | postgres:5432 |
| `ADMIN_PORT` | `8080` | admin-ui:80 |
| `PROMETHEUS_PORT` | `9091` | prometheus:9090 |
| `GRAFANA_PORT` | `3001` | grafana:3000 |
| `LOKI_PORT` | `3100` | loki:3100 |
| `GRAFANA_PASSWORD` | `admin` | Grafana admin password |

### Batch Processing Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `BATCH_SIZE` | 10 | PDFs per batch |
| `MAX_BATCHES` | 20 | Maximum batches per parent run |
| `COORDINATOR_POLL_INTERVAL` | 10s | Batch coordinator polling interval |
| `COORDINATOR_TIMEOUT` | 4h | Maximum batch processing time |

### Pipeline Timeouts

| Stage | Timeout | Description |
|-------|---------|-------------|
| Gemini API | 3 retries with exponential backoff | Rate limit: `attempt * 2s` |
| Similarity (Python) | 60 minutes | `find_similar_questions.py` execution |
| Similarity (buffer) | 100 MB | Python stdout/stderr max buffer |
| Categorize (DB transaction) | 60 seconds | Serializable transaction timeout |
| Categorize (upsert chunk) | 100 questions | Questions per DB upsert batch |

### Category Configuration

Default categories are defined in `config/categories.json`. Each tenant can customize their categories via the admin UI. Categories support optional subcategories:

```json
{
  "key": "propedeutika",
  "name": "Propedeutika",
  "subcategory": "A természetes életmód",
  "file": "propedeutika_a_termeszetes_eletmod.json",
  "sortOrder": 1
}
```

### Database Schema Summary

| Model | Key Fields | Relations |
|-------|-----------|-----------|
| **Tenant** | name, slug, geminiApiKey, maxConcurrentPipelines, storageQuotaMb | → Users, PipelineRuns, Categories, Questions |
| **User** | email, passwordHash, role (SUPER_ADMIN/TENANT_ADMIN/TENANT_USER) | → Tenant |
| **TenantCategory** | key, name, subcategory?, file, sortOrder | → Tenant |
| **PipelineRun** | status, currentStage, filenames, totalPdfs, processedPdfs, parentRunId? | → Tenant, Jobs, Questions, Children |
| **PipelineJob** | stage, status, progress, result, errorMessage | → PipelineRun |
| **Question** | file (unique per tenant), data (JSON), categorization (JSON), similarityGroupId, markedWrong | → Tenant, PipelineRun |

### Build & Development Commands

```bash
# Install dependencies
pnpm install

# Generate Prisma client
pnpm run db:generate

# Build all packages
pnpm run build

# Development mode
pnpm run dev:api      # API server with hot reload
pnpm run dev:workers  # Workers with hot reload
pnpm run dev:admin    # Admin UI with Vite HMR

# Quality checks
pnpm run lint         # ESLint
pnpm run typecheck    # TypeScript type checking (build must run first for shared .d.ts)
pnpm run test         # Vitest test suite

# Docker
docker compose up -d              # Start all services
docker compose up -d --build      # Rebuild and start
docker compose logs -f api workers # Follow service logs
```
