import { z } from "zod";

const EnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().default("postgresql://exams2quiz:exams2quiz@localhost:5432/exams2quiz"),

  // Redis
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().default(""),

  // API
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().default("change-me-in-production"),

  // Workers
  WORKER_CONCURRENCY: z.coerce.number().default(3),
  GEMINI_API_KEY: z.string().default(""),

  // Storage
  UPLOAD_DIR: z.string().default("/data/uploads"),
  OUTPUT_DIR: z.string().default("/data/output"),

  // Monitoring
  METRICS_PORT: z.coerce.number().default(9090),

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
