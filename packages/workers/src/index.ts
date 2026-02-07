import { getConfig } from "@exams2quiz/shared/config";
import { closeAllQueues } from "@exams2quiz/shared/queue";
import { disconnectDb } from "@exams2quiz/shared/db";
import { PipelineStage } from "@exams2quiz/shared/types";
import { createPdfExtractWorker } from "./stages/pdf-extract.js";
import { createGeminiParseWorker } from "./stages/gemini-parse.js";
import { createCategorizeWorker } from "./stages/categorize.js";
import { createSimilarityWorker } from "./stages/similarity.js";
import { createCategorySplitWorker } from "./stages/category-split.js";
import { createBatchCoordinateWorker } from "./stages/batch-coordinate.js";
import { instrumentWorker, startWorkerMetricsServer, stopWorkerMetricsServer } from "./metrics.js";

const config = getConfig();

console.log(`[workers] Starting workers in ${config.NODE_ENV} mode...`);
console.log(`[workers] Redis: ${config.REDIS_HOST}:${config.REDIS_PORT}`);
console.log(`[workers] Concurrency: ${config.WORKER_CONCURRENCY}`);

// ─── Register pipeline stage workers ──────────────────────────────
const pdfExtractWorker = createPdfExtractWorker();
const geminiParseWorker = createGeminiParseWorker();
const categorizeWorker = createCategorizeWorker();
const similarityWorker = createSimilarityWorker();
const categorySplitWorker = createCategorySplitWorker();
const batchCoordinateWorker = createBatchCoordinateWorker();

const workers = [
  pdfExtractWorker,
  geminiParseWorker,
  categorizeWorker,
  similarityWorker,
  categorySplitWorker,
  batchCoordinateWorker,
];

// ─── Instrument workers with Prometheus metrics ──────────────────
instrumentWorker(pdfExtractWorker, PipelineStage.PDF_EXTRACT);
instrumentWorker(geminiParseWorker, PipelineStage.GEMINI_PARSE);
instrumentWorker(categorizeWorker, PipelineStage.CATEGORIZE);
instrumentWorker(similarityWorker, PipelineStage.SIMILARITY);
instrumentWorker(categorySplitWorker, PipelineStage.CATEGORY_SPLIT);
instrumentWorker(batchCoordinateWorker, PipelineStage.BATCH_COORDINATE);

console.log(`[workers] ${workers.length} worker(s) registered and instrumented`);

// ─── Start metrics server ────────────────────────────────────────
startWorkerMetricsServer().catch((err) => {
  console.error("[workers] Failed to start metrics server:", err);
});

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[workers] ${signal} received, shutting down...`);
  await stopWorkerMetricsServer();
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  await disconnectDb();
  console.log("[workers] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
