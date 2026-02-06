import Fastify, { type FastifyInstance } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Registry,
} from "prom-client";
import { type Worker } from "bullmq";
import { getConfig } from "@exams2quiz/shared/config";
import { getDb } from "@exams2quiz/shared/db";

const register = new Registry();

collectDefaultMetrics({ register, prefix: "worker_" });

// ─── Worker Job Metrics ──────────────────────────────────────────
const jobsCompletedTotal = new Counter({
  name: "worker_jobs_completed_total",
  help: "Total completed jobs by stage",
  labelNames: ["stage"] as const,
  registers: [register],
});

const jobsFailedTotal = new Counter({
  name: "worker_jobs_failed_total",
  help: "Total failed jobs by stage",
  labelNames: ["stage"] as const,
  registers: [register],
});

const jobDurationSeconds = new Histogram({
  name: "worker_job_duration_seconds",
  help: "Job processing duration in seconds",
  labelNames: ["stage"] as const,
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

const activeJobs = new Gauge({
  name: "worker_active_jobs",
  help: "Number of currently active jobs by stage",
  labelNames: ["stage"] as const,
  registers: [register],
});

// ─── Instrument Workers ─────────────────────────────────────────
export function instrumentWorker(worker: Worker, stage: string): void {
  worker.on("completed", (job) => {
    jobsCompletedTotal.inc({ stage });
    if (job.processedOn && job.finishedOn) {
      const duration = (job.finishedOn - job.processedOn) / 1000;
      jobDurationSeconds.observe({ stage }, duration);
    }
  });

  worker.on("failed", (job, err) => {
    jobsFailedTotal.inc({ stage });

    // Safety net: if the processor crashed (e.g. native module error),
    // the in-processor catch block never ran, so ensure the pipeline
    // run is marked FAILED to avoid blocking the concurrency limit.
    const pipelineRunId = job?.data?.pipelineRunId as string | undefined;
    if (pipelineRunId) {
      const errorMsg = err?.message ?? String(err);
      const db = getDb();
      db.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { status: "FAILED", errorMessage: errorMsg },
      }).catch((e: unknown) => {
        console.error(`[metrics] Failed to mark pipeline run ${pipelineRunId} as FAILED:`, e);
      });
    }
  });

  worker.on("active", () => {
    activeJobs.inc({ stage });
  });

  // Decrement active on completed or failed
  const decActive = () => activeJobs.dec({ stage });
  worker.on("completed", decActive);
  worker.on("failed", decActive);
}

// ─── Metrics Server ─────────────────────────────────────────────
let metricsServer: FastifyInstance | null = null;

export async function startWorkerMetricsServer(): Promise<void> {
  const config = getConfig();
  metricsServer = Fastify({ logger: false });

  metricsServer.get("/metrics", async (_request, reply) => {
    const metrics = await register.metrics();
    reply.header("Content-Type", register.contentType);
    return metrics;
  });

  metricsServer.get("/health", async () => ({ status: "ok" }));

  await metricsServer.listen({ host: "0.0.0.0", port: config.METRICS_PORT });
  console.log(`[metrics] Worker metrics server on port ${config.METRICS_PORT}`);
}

export async function stopWorkerMetricsServer(): Promise<void> {
  if (metricsServer) {
    await metricsServer.close();
  }
}
