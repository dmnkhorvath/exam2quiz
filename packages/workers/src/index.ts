import { getConfig } from "@exams2quiz/shared/config";
import { closeAllQueues } from "@exams2quiz/shared/queue";
import { disconnectDb } from "@exams2quiz/shared/db";
import { createPdfExtractWorker } from "./stages/pdf-extract.js";
import { createGeminiParseWorker } from "./stages/gemini-parse.js";
import { createCategorizeWorker } from "./stages/categorize.js";

const config = getConfig();

console.log(`[workers] Starting workers in ${config.NODE_ENV} mode...`);
console.log(`[workers] Redis: ${config.REDIS_HOST}:${config.REDIS_PORT}`);
console.log(`[workers] Concurrency: ${config.WORKER_CONCURRENCY}`);

// ─── Register pipeline stage workers ──────────────────────────────
const workers = [
  createPdfExtractWorker(),
  createGeminiParseWorker(),
  createCategorizeWorker(),
  // Future stages:
  // createSimilarityWorker(),
  // createCategorySplitWorker(),
];

console.log(`[workers] ${workers.length} worker(s) registered`);

// ─── Graceful shutdown ────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[workers] ${signal} received, shutting down...`);
  await Promise.all(workers.map((w) => w.close()));
  await closeAllQueues();
  await disconnectDb();
  console.log("[workers] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
