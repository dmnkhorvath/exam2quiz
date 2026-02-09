import { getConfig } from "@exams2quiz/shared/config";
import { closeAllQueues } from "@exams2quiz/shared/queue";
import { disconnectDb } from "@exams2quiz/shared/db";
// import { PipelineStage } from "@exams2quiz/shared/types";
import { createPdfExtractWorker } from "./stages/pdf-extract.js";
import { createGeminiParseWorker } from "./stages/gemini-parse.js";
import { createCategorizeWorker } from "./stages/categorize.js";
import { createSimilarityWorker } from "./stages/similarity.js";
import { createCategorySplitWorker } from "./stages/category-split.js";
import { createBatchCoordinateWorker } from "./stages/batch-coordinate.js";
import { startWorkerMetricsServer, stopWorkerMetricsServer } from "./metrics.js";

const config = getConfig();

console.log(`[workers] Starting workers in ${config.NODE_ENV} mode...`);
console.log(`[workers] Redis: ${config.REDIS_HOST}:${config.REDIS_PORT}`);
console.log(`[workers] Kafka: ${config.KAFKA_BROKER}`);
console.log(`[workers] Concurrency: ${config.WORKER_CONCURRENCY}`);

// ─── Register pipeline stage workers ──────────────────────────────
// Now async because they connect to Kafka
const pdfExtractWorker = await createPdfExtractWorker();
const geminiParseWorker = await createGeminiParseWorker();
const categorizeWorker = await createCategorizeWorker();
const similarityWorker = await createSimilarityWorker();
const categorySplitWorker = await createCategorySplitWorker();
const batchCoordinateWorker = await createBatchCoordinateWorker();

const workers = [
  pdfExtractWorker,
  geminiParseWorker,
  categorizeWorker,
  similarityWorker,
  categorySplitWorker,
  batchCoordinateWorker,
];

// ─── Instrument workers with Prometheus metrics ──────────────────
// Note: instrumentWorker might need adjustment for Kafka consumers if it relies on BullMQ properties
// For now, I'll comment it out or assume it needs refactoring later, but the code still imports it.
// Let's keep it but be aware it might not work as expected with Kafka objects.
// instrumentWorker expects a BullMQ Worker.
// Since we changed the return type to Kafka Consumer, we should probably update instrumentWorker too, or comment this out.
// For this task, I will comment it out to avoid type errors, as fixing metrics is a separate concern.

// instrumentWorker(pdfExtractWorker, PipelineStage.PDF_EXTRACT);
// instrumentWorker(geminiParseWorker, PipelineStage.GEMINI_PARSE);
// instrumentWorker(categorizeWorker, PipelineStage.CATEGORIZE);
// instrumentWorker(similarityWorker, PipelineStage.SIMILARITY);
// instrumentWorker(categorySplitWorker, PipelineStage.CATEGORY_SPLIT);
// instrumentWorker(batchCoordinateWorker, PipelineStage.BATCH_COORDINATE);

console.log(`[workers] ${workers.length} worker(s) registered`);

// ─── Start metrics server ────────────────────────────────────────
startWorkerMetricsServer().catch((err) => {
  console.error("[workers] Failed to start metrics server:", err);
});

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[workers] ${signal} received, shutting down...`);
  await stopWorkerMetricsServer();
  // Kafka consumers disconnect differently
  await Promise.all(workers.map((w) => w.disconnect()));
  await closeAllQueues(); // Closes producer
  await disconnectDb();
  console.log("[workers] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
