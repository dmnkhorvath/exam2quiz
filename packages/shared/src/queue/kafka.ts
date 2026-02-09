import { Kafka, Consumer, Producer, logLevel, EachMessagePayload } from "kafkajs";
import { getKafkaConfig } from "../config/index.js";
import { PipelineStage } from "../types/index.js";

let kafka: Kafka;
let producer: Producer;

export function getKafka() {
  if (!kafka) {
    const config = getKafkaConfig();
    kafka = new Kafka({
      ...config,
      logLevel: logLevel.ERROR,
    });
  }
  return kafka;
}

export async function getProducer() {
  if (!producer) {
    const client = getKafka();
    producer = client.producer();
    await producer.connect();
  }
  return producer;
}

export function getTopicName(stage: PipelineStage, _tenantId?: string): string {
  // Kafka topics should probably not be tenant-specific if we want to scale consumers easily
  // But preserving existing logic for now.
  // Ideally, topics are just stage names, and tenantId is in the message key/header.
  // The requirement says "separate topics separate consumers", which aligns with stage separation.
  // The current implementation uses tenant-specific queues.
  // Let's stick to stage-based topics and use message headers/key for tenant.
  // Wait, if I change to stage-based topics, I need to ensure existing logic that relies on tenant queues still works or is refactored.
  // The prompt says "separate topics separate consumers". This usually means one topic per stage.

  return `exams2quiz-${stage}`;
}

export async function produceMessage<T>(
  stage: PipelineStage,
  key: string,
  value: T,
  headers?: Record<string, string>
): Promise<void> {
  const producer = await getProducer();
  const topic = getTopicName(stage);

  await producer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(value),
        headers,
      },
    ],
  });
}

export async function createConsumer(
  groupId: string,
  topics: string[],
  handler: (payload: EachMessagePayload) => Promise<void>
): Promise<Consumer> {
  const client = getKafka();
  const consumer = client.consumer({ groupId });

  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });

  await consumer.run({
    eachMessage: handler,
  });

  return consumer;
}

export async function disconnectKafka() {
  if (producer) {
    await producer.disconnect();
  }
  // Consumers should be disconnected by their owners
}
