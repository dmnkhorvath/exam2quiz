# Scalability Plan: 300+ Document Parallel Pipeline Processing

## Problem Statement

The current pipeline processes all documents in a single BullMQ job per stage. With 300+ PDFs:
- **pdf-extract** processes PDFs sequentially in a loop — no parallelism
- **gemini-parse** processes 4500+ images in batches of 10 — extremely slow in one job
- **categorize** upserts all questions in a single `SERIALIZABLE` transaction (30s timeout) — will fail
- **similarity** runs one Python process with 30min timeout — O(n²) on 4500+ questions
- A single failure at document 299 loses all prior work (no checkpointing)
- BullMQ lock duration (10min) exceeded by long-running monolithic jobs

**User requirement:** Similarity must only run after ALL documents are fully resolved (parsed + categorized).

---

## Architecture: Batched Pipeline with Fan-Out/Fan-In

### Concept

Introduce a **parent-child pipeline model**:
1. A **parent PipelineRun** accepts 300+ documents and splits them into batches
2. **Child PipelineRuns** (one per batch) process stages 1-3 independently and in parallel
3. A **coordinator** waits for all children to complete categorize
4. Parent runs **similarity** and **category-split** once on the full merged dataset

This is essentially an automated version of the existing merge pipeline feature, but with orchestrated fan-out/fan-in.

```
User uploads 300 PDFs
        │
   Parent PipelineRun (status: RUNNING, type: BATCH_PARENT)
        │
   ┌────┼────┬────┬────┬── ... ──┐
   │    │    │    │    │         │
 Batch1 B2  B3  B4  B5  ...   B10   (30 PDFs each)
   │    │    │    │    │         │
   ├─ pdf-extract ──────────────┤    ← parallel, independent
   ├─ gemini-parse ─────────────┤    ← parallel, independent
   ├─ categorize ───────────────┤    ← parallel, each upserts its own batch
   │                            │
   └──────────┬─────────────────┘
              │
        All batches COMPLETED?
              │
     Parent: similarity (full tenant question set)
              │
     Parent: category-split
              │
          COMPLETED
```

---

## Implementation Tasks (ordered)

### Task 1: Schema Changes

**File:** `packages/shared/prisma/schema.prisma`

Add batch orchestration fields to `PipelineRun`:

```prisma
model PipelineRun {
  // ... existing fields ...

  // Batch orchestration
  parentRunId     String?        // null for standalone/parent runs
  parentRun       PipelineRun?   @relation("BatchChildren", fields: [parentRunId], references: [id])
  childRuns       PipelineRun[]  @relation("BatchChildren")
  batchIndex      Int?           // 0-based index within parent
  batchSize       Int?           // configured batch size (e.g. 30)
  totalBatches    Int?           // total number of child batches

  @@index([parentRunId, status])
}
```

No new tables needed — reuses existing `PipelineRun` and `PipelineJob` models.

### Task 2: Shared Types & Constants

**File:** `packages/shared/src/types/index.ts`

```typescript
// New job data for the batch coordinator
export interface BatchCoordinatorJobData {
  tenantId: string;
  parentPipelineRunId: string;
  childPipelineRunIds: string[];
}

// Configuration constants
export const BATCH_DEFAULTS = {
  BATCH_SIZE: 30,           // PDFs per batch
  MAX_BATCHES: 20,          // Safety limit
  COORDINATOR_POLL_INTERVAL: 10_000,  // 10s polling
  COORDINATOR_TIMEOUT: 4 * 60 * 60 * 1000, // 4 hours max
} as const;
```

**File:** `packages/shared/src/types/index.ts` — add new stage:

```typescript
export const PipelineStage = {
  PDF_EXTRACT: "pdf-extract",
  GEMINI_PARSE: "gemini-parse",
  CATEGORIZE: "categorize",
  BATCH_COORDINATE: "batch-coordinate",  // NEW
  SIMILARITY: "similarity",
  CATEGORY_SPLIT: "category-split",
} as const;
```

### Task 3: Queue Registration for Coordinator

**File:** `packages/shared/src/queue/index.ts`

Register the `batch-coordinate` queue. No special config needed — uses same defaults.

### Task 4: API — Batch Pipeline Creation

**File:** `packages/api/src/routes/pipelines.ts`

Modify the `POST /api/pipelines` handler:

```
IF pdfCount > BATCH_SIZE:
  1. Create parent PipelineRun (type indicators via new fields)
  2. Split pdfPaths into chunks of BATCH_SIZE
  3. For each chunk:
     a. Create child PipelineRun with parentRunId, batchIndex
     b. Copy chunk's PDFs to child's upload dir
     c. Create PipelineJob for pdf-extract
     d. Enqueue pdf-extract BullMQ job
  4. Create PipelineJob for batch-coordinate on PARENT
  5. Enqueue batch-coordinate BullMQ job with childPipelineRunIds
  6. Return parent run ID + child run IDs to client

ELSE (≤ BATCH_SIZE):
  Existing behavior (no change)
```

The `maxConcurrentPipelines` check should count parent runs only (not children) or be increased/configurable. Children are internal implementation detail.

### Task 5: Batch Coordinator Worker (NEW)

**New file:** `packages/workers/src/stages/batch-coordinate.ts`

The coordinator is the fan-in synchronization point:

```
processBatchCoordinate(job):
  1. Poll DB every 10s: check all child PipelineRuns' status
  2. If ANY child FAILED → mark parent FAILED, abort
  3. If ALL children COMPLETED (through categorize):
     a. Load all tenant questions from DB (same as categorize's merge logic)
     b. Write categorized_merged.json to parent's output dir
     c. Enqueue similarity job on parent PipelineRun
     d. Mark coordinator job COMPLETED
  4. Timeout after 4 hours → mark parent FAILED
```

**Key detail:** Children's categorize stage already upserts questions to the shared `Question` table via serializable transactions. The coordinator just needs to wait, then read the merged dataset from DB.

BullMQ configuration for this worker:
- `lockDuration: 4 * 60 * 60 * 1000` (4 hours — this is a long-polling job)
- `stalledInterval: 30 * 60 * 1000` (30 min)
- Use `job.updateProgress()` periodically to prevent stalling
- Concurrency: 3 (same as other workers)

### Task 6: Modify Child Pipeline Stage Chaining

**Files:** `packages/workers/src/stages/categorize.ts`

After categorize completes, check if this is a child run (`parentRunId !== null`):

```
IF parentRunId is set:
  → Do NOT enqueue similarity. Mark child PipelineRun as COMPLETED.
  → The batch coordinator will handle similarity.

ELSE:
  → Existing behavior: enqueue similarity as next stage.
```

This is the **only change** to existing worker logic. The pdf-extract and gemini-parse stages don't need changes — they already work on arbitrary PDF lists.

### Task 7: Adjust `maxConcurrentPipelines` Enforcement

**File:** `packages/api/src/routes/pipelines.ts`

Two options (choose one):
- **Option A:** Exclude child runs from the count (`WHERE parentRunId IS NULL`)
- **Option B:** Add a separate `maxConcurrentBatches` field to Tenant

Recommend **Option A** — simpler, child runs are an internal detail.

### Task 8: Categorize Transaction Resilience

**File:** `packages/workers/src/stages/categorize.ts`

With batches of 30 PDFs (~450 questions per batch), the serializable transaction should work fine within 30s. But for safety:

- Increase transaction timeout to 60s for large batches
- Add chunked upserts: process questions in groups of 100 within the transaction

### Task 9: Admin UI — Batch Visibility

**File:** `packages/admin-ui/src/` (relevant components)

- Show parent pipeline with expandable child batches
- Parent status shows overall progress (e.g., "7/10 batches complete")
- Child failures visible under parent

### Task 10: Similarity Timeout Increase

**File:** `packages/workers/src/stages/similarity.ts`

With 300+ docs producing potentially 4500+ questions across the tenant, the 30-minute timeout may not suffice:

- Make timeout configurable via env: `SIMILARITY_TIMEOUT_MS` (default: 60 min)
- Increase `maxBuffer` if needed
- Consider: the Python script groups by category first, so it's not truly O(n²) globally — it's O(n²) per category, which is more manageable

---

## Execution Order & Dependencies

```
Task 1 (Schema) ─────────────────────────────────┐
Task 2 (Types)  ─────────────────────────────────┤
Task 3 (Queue)  ─────────────────────────────────┤
                                                  ├─► Task 4 (API batch creation)
                                                  ├─► Task 5 (Coordinator worker)
                                                  ├─► Task 6 (Categorize child check)
                                                  ├─► Task 7 (Concurrent limit fix)
                                                  └─► Task 8 (Transaction resilience)
                                                            │
                                                            ├─► Task 9 (Admin UI)
                                                            └─► Task 10 (Similarity timeout)
```

Tasks 1-3 are foundational (do first, single commit).
Tasks 4-8 are the core implementation (can be parallelized across developers).
Tasks 9-10 are polish/safety.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Batch size | 30 PDFs | ~450 questions per batch. Fits in categorize's 30s transaction. 10 batches for 300 docs = good parallelism without overwhelming Gemini API. |
| Coordination method | Polling (not events) | BullMQ doesn't support cross-queue dependencies natively. Polling is simple, reliable, and the coordinator job is long-lived anyway. |
| Child runs reuse PipelineRun | Yes | No new tables. Reuses all existing job tracking, error handling, and admin UI. `parentRunId` field distinguishes them. |
| Similarity runs on parent | Yes | Similarity needs the full tenant question set. Running once on the parent avoids N redundant similarity passes. |
| Children skip similarity | Yes | Children complete at categorize stage. Saves compute, avoids conflicting similarity results. |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Coordinator stalls (no progress updates) | BullMQ marks job as stalled | Update progress on every poll cycle |
| One child fails, others wasted | Compute waste | Coordinator detects failure early, can cancel remaining children |
| Gemini rate limits across 10 parallel batches | All batches hit 429s | Each batch already has exponential backoff. Consider adding a global semaphore or staggered start (delayed jobs in BullMQ). |
| DB connection pool exhaustion | 10 batches × 3 stages = 30 concurrent DB users | Ensure pool size ≥ 50 in production. Monitor with existing metrics. |
| Categorize serializable transactions conflict | Deadlocks across batches for same tenant | Each batch upserts different questions (different files). The serializable transaction prevents read skew on `findMany`, but concurrent upserts on different rows won't deadlock. |

---

## Configuration Summary

| Setting | Default | Env Var |
|---------|---------|---------|
| Batch size (PDFs per batch) | 30 | `BATCH_SIZE` |
| Max batches per parent | 20 | `MAX_BATCHES` |
| Coordinator poll interval | 10s | `COORDINATOR_POLL_INTERVAL_MS` |
| Coordinator timeout | 4h | `COORDINATOR_TIMEOUT_MS` |
| Similarity timeout | 60min | `SIMILARITY_TIMEOUT_MS` |

---

## What Stays The Same

- **Worker concurrency model**: Still uses `WORKER_CONCURRENCY` (default 3). Each batch is a normal BullMQ job.
- **Error handling pattern**: All 5 stages + coordinator use identical catch block pattern (update PipelineJob + PipelineRun status).
- **Tenant question merge**: Categorize still upserts to shared Question table. Similarity still reads full tenant set.
- **Single-doc pipelines**: < BATCH_SIZE docs follow existing path with zero changes.
- **Merge pipeline feature**: Still works. Could even merge completed batch parents.
