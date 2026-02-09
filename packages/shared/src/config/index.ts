import { z } from "zod";

const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().default("postgresql://exams2quiz:exams2quiz@localhost:5432/exams2quiz"),

  // Redis
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(""),

  // Kafka
  KAFKA_BROKER: z.string().default("localhost:9092"),
  KAFKA_CLIENT_ID: z.string().default("exams2quiz"),

  // API
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().default("change-me-in-production"),

  // Workers
  WORKER_CONCURRENCY: z.coerce.number().default(3),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_API_BASE_URL: z.string().default(""),

  // Storage
  UPLOAD_DIR: z.string().default("/data/uploads"),
  OUTPUT_DIR: z.string().default("/data/output"),

  // Monitoring
  METRICS_PORT: z.coerce.number().default(9090),

  // Cache Redis (separate instance for HTML caching)
  CACHE_REDIS_HOST: z.string().default("localhost"),
  CACHE_REDIS_PORT: z.coerce.number().default(6380),
  CACHE_REDIS_PASSWORD: z.string().default(""),
  CACHE_TTL_SECONDS: z.coerce.number().default(300),

  // Environment
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

let _config: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!_config) {
    _config = EnvSchema.parse(process.env);
  }
  return _config;
}

export function getRedisConfig() {
  const config = getConfig();
  return {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

export function getCacheRedisConfig() {
  const config = getConfig();
  return {
    host: config.CACHE_REDIS_HOST,
    port: config.CACHE_REDIS_PORT,
    password: config.CACHE_REDIS_PASSWORD || undefined,
  };
}

export function getKafkaConfig() {
  const config = getConfig();
  return {
    clientId: config.KAFKA_CLIENT_ID,
    brokers: [config.KAFKA_BROKER],
    retry: {
      initialRetryTime: 100,
      retries: 5,
    },
  };
}
