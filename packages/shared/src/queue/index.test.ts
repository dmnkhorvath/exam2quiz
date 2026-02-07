import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock bullmq before importing the module
vi.mock("bullmq", () => {
  class MockQueue {
    add = vi.fn().mockResolvedValue({ id: "job-123" });
    close = vi.fn().mockResolvedValue(undefined);
  }

  class MockWorker {
    close = vi.fn().mockResolvedValue(undefined);
  }

  return { Queue: MockQueue, Worker: MockWorker };
});

// Mock config to avoid env issues
vi.mock("../config/index.js", () => ({
  getRedisConfig: () => ({
    host: "localhost",
    port: 6379,
    password: undefined,
    maxRetriesPerRequest: null,
  }),
}));

import { getQueueName, getQueue, createWorker, addJob, closeAllQueues } from "./index.js";

describe("getQueueName", () => {
  it("returns stage-based queue name without tenant", () => {
    expect(getQueueName("pdf-extract")).toBe("exams2quiz-pdf-extract");
    expect(getQueueName("gemini-parse")).toBe("exams2quiz-gemini-parse");
    expect(getQueueName("categorize")).toBe("exams2quiz-categorize");
  });

  it("returns tenant-namespaced queue name", () => {
    expect(getQueueName("pdf-extract", "tenant-123")).toBe(
      "exams2quiz-pdf-extract-tenant-123",
    );
  });

  it("handles all pipeline stages", () => {
    const stages = [
      "pdf-extract",
      "gemini-parse",
      "categorize",
      "batch-coordinate",
      "similarity",
      "category-split",
    ] as const;
    for (const stage of stages) {
      expect(getQueueName(stage)).toMatch(/^exams2quiz-/);
    }
  });
});

describe("getQueue", () => {
  beforeEach(async () => {
    // Clear cached queues between tests
    await closeAllQueues();
  });

  it("creates a queue for a pipeline stage", () => {
    const queue = getQueue("pdf-extract");
    expect(queue).toBeDefined();
  });

  it("returns the same queue for the same stage (caching)", () => {
    const q1 = getQueue("categorize");
    const q2 = getQueue("categorize");
    expect(q1).toBe(q2);
  });
});

describe("createWorker", () => {
  it("creates a worker for a pipeline stage", () => {
    const processor = vi.fn();
    const worker = createWorker("pdf-extract", processor);
    expect(worker).toBeDefined();
  });
});

describe("addJob", () => {
  it("adds a job to the queue and returns job id", async () => {
    const jobId = await addJob("pdf-extract", { tenantId: "t1" });
    expect(jobId).toBe("job-123");
  });
});

describe("closeAllQueues", () => {
  it("closes all queues without error", async () => {
    getQueue("pdf-extract");
    getQueue("categorize");
    await expect(closeAllQueues()).resolves.toBeUndefined();
  });
});
