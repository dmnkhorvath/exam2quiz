import { Queue, Worker, type JobsOptions, type WorkerOptions, type Processor } from "bullmq";
import { getRedisConfig } from "../config/index.js";
import { PipelineStage } from "../types/index.js";

// ─── Queue Names (tenant-namespaced) ───────────────────────────────
export function getQueueName(stage: PipelineStage, tenantId?: string): string {
  const base = `exams2quiz:${stage}`;
  return tenantId ? `${base}:${tenantId}` : base;
}

// ─── Queue Factory ─────────────────────────────────────────────────
const queues = new Map<string, Queue>();

export function getQueue(stage: PipelineStage, tenantId?: string): Queue {
  const name = getQueueName(stage, tenantId);
  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(name, {
        connection: getRedisConfig(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      }),
    );
  }
  return queues.get(name)!;
}

// ─── Worker Factory ────────────────────────────────────────────────
export function createWorker<T>(
  stage: PipelineStage,
  processor: Processor<T>,
  opts?: Partial<WorkerOptions>,
): Worker<T> {
  // Workers listen on the global queue (no tenant suffix) — tenant is in job data
  const name = getQueueName(stage);
  return new Worker<T>(name, processor, {
    connection: getRedisConfig(),
    concurrency: 3,
    ...opts,
  });
}

// ─── Add Job Helper ────────────────────────────────────────────────
export async function addJob<T extends Record<string, unknown>>(
  stage: PipelineStage,
  data: T,
  opts?: JobsOptions,
): Promise<string> {
  const queue = getQueue(stage);
  const job = await queue.add(stage, data, opts);
  return job.id ?? "";
}

// ─── Graceful Shutdown ─────────────────────────────────────────────
export async function closeAllQueues(): Promise<void> {
  const promises = Array.from(queues.values()).map((q) => q.close());
  await Promise.all(promises);
  queues.clear();
}
