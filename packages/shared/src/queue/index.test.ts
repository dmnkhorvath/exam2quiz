import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => {
  const mockProducer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue([{ topicName: "test-topic", partition: 0, errorCode: 0 }]),
  };

  const mockConsumer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
  };

  const mockKafka = {
    producer: vi.fn(() => mockProducer),
    consumer: vi.fn(() => mockConsumer),
  };

  return {
    mockProducer,
    mockConsumer,
    mockKafka,
  };
});

vi.mock("kafkajs", () => {
  return {
    Kafka: class {
      constructor() {
        return mocks.mockKafka;
      }
    },
    logLevel: { ERROR: 1 },
  };
});

// Mock config
vi.mock("../config/index.js", () => ({
  getRedisConfig: () => ({
    host: "localhost",
    port: 6379,
  }),
  getKafkaConfig: () => ({
    brokers: ["localhost:9092"],
    clientId: "test-client",
  }),
}));

import { createWorker, addJob, closeAllQueues } from "./index.js";
import { PipelineStage } from "../types/index.js";

describe("Queue (Kafka)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeAllQueues();
  });

  describe("addJob", () => {
    it("produces a message to the correct topic", async () => {
      const data = { tenantId: "tenant-1", pipelineRunId: "run-1", foo: "bar" };
      const jobId = await addJob(PipelineStage.PDF_EXTRACT, data);

      expect(mocks.mockKafka.producer).toHaveBeenCalled();
      expect(mocks.mockProducer.connect).toHaveBeenCalled();
      expect(mocks.mockProducer.send).toHaveBeenCalledWith({
        topic: "exams2quiz-pdf-extract",
        messages: [
          {
            key: "tenant-1",
            value: JSON.stringify(data),
            headers: undefined,
          },
        ],
      });
      expect(jobId).toBe("kafka-queued");
    });

    it("uses pipelineRunId as key if tenantId is missing", async () => {
      const data = { pipelineRunId: "run-2", foo: "baz" };
      await addJob(PipelineStage.CATEGORIZE, data);

      expect(mocks.mockProducer.send).toHaveBeenCalledWith(expect.objectContaining({
        topic: "exams2quiz-categorize",
        messages: [expect.objectContaining({ key: "run-2" })],
      }));
    });
  });

  describe("createWorker", () => {
    it("creates a consumer for the correct topic and group", async () => {
      const processor = vi.fn().mockResolvedValue(undefined);
      const worker = await createWorker(PipelineStage.PDF_EXTRACT, processor);

      expect(mocks.mockKafka.consumer).toHaveBeenCalledWith({
        groupId: "exams2quiz-pdf-extract-group",
        sessionTimeout: 300_000,
        heartbeatInterval: 10_000,
        maxWaitTimeInMs: 5_000,
      });
      expect(mocks.mockConsumer.connect).toHaveBeenCalled();
      expect(mocks.mockConsumer.subscribe).toHaveBeenCalledWith({
        topics: ["exams2quiz-pdf-extract"],
        fromBeginning: false,
      });
      expect(mocks.mockConsumer.run).toHaveBeenCalled();
      expect(worker).toBe(mocks.mockConsumer);
    });

    it("processes messages using the provided processor", async () => {
      const processor = vi.fn().mockResolvedValue(undefined);
      await createWorker(PipelineStage.PDF_EXTRACT, processor);

      // Get the handler passed to consumer.run
      const runCall = mocks.mockConsumer.run.mock.calls[0][0];
      const handler = runCall.eachMessage;

      expect(handler).toBeDefined();

      // Simulate a message
      const payload = {
        topic: "exams2quiz-pdf-extract",
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify({ tenantId: "t1", foo: "bar" })),
        },
      };

      await handler(payload);

      expect(processor).toHaveBeenCalledWith({
        data: { tenantId: "t1", foo: "bar" },
      });
    });
  });

  describe("closeAllQueues", () => {
    it("disconnects producer", async () => {
      // Trigger producer creation
      await addJob(PipelineStage.PDF_EXTRACT, {});

      await closeAllQueues();
      expect(mocks.mockProducer.disconnect).toHaveBeenCalled();
    });
  });
});
