import { produceMessage, createConsumer, disconnectKafka } from "./kafka.js";
import { PipelineStage } from "../types/index.js";
import { EachMessagePayload } from "kafkajs";

// Re-export Kafka functions
export { produceMessage, createConsumer, disconnectKafka };

// ─── Add Job Helper (Refactored to Produce Message) ──────────────────
export async function addJob<T extends Record<string, unknown>>(
  stage: PipelineStage,
  data: T,
  _opts?: any // Ignored for Kafka
): Promise<string> {
  // Use tenantId or pipelineRunId as key for partitioning
  const key = (data.tenantId as string) || (data.pipelineRunId as string) || "default";

  await produceMessage(stage, key, data);

  // Return a placeholder ID since Kafka doesn't give one synchronously in the same format
  // We could return partition:offset but that requires waiting for ack and parsing result
  return "kafka-queued";
}

// ─── Worker Factory (Refactored to Create Consumer) ──────────────────
// This changes the signature and return type!
// Callers must be updated.
export async function createWorker(
  stage: PipelineStage,
  processor: (job: { data: any }) => Promise<any>,
  _opts?: any
) {
  // Consumers need a group ID. We can use the stage name + "group".
  // Or "exams2quiz-workers" if we want all workers in one group (balanced).
  // But usually we want different consumer groups for different stages?
  // No, actually for the SAME stage we want a consumer group to load balance.
  const groupId = `exams2quiz-${stage}-group`;
  const topic = `exams2quiz-${stage}`;

  return createConsumer(groupId, [topic], async (payload: EachMessagePayload) => {
    const { message } = payload;
    if (!message.value) return;

    try {
      const data = JSON.parse(message.value.toString());
      // Adapt to match BullMQ processor signature roughly
      await processor({ data });
    } catch (error) {
      console.error(`Error processing message from ${topic}:`, error);
      // In Kafka, throwing usually means we don't commit offset, so it will be retried?
      // kafkajs by default retries on crash, but if we catch it here we must decide.
      // If we swallow error, it's considered "done".
      // BullMQ workers rely on throwing to fail the job.
      throw error;
    }
  });
}

export async function closeAllQueues(): Promise<void> {
  await disconnectKafka();
}

