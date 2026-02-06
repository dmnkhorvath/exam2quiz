import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { getConfig } from "@exams2quiz/shared/config";
import { disconnectDb } from "@exams2quiz/shared/db";
import { closeAllQueues } from "@exams2quiz/shared/queue";
import { authPlugin } from "./plugins/auth.js";
import { metricsPlugin, startMetricsServer, stopMetricsServer } from "./plugins/metrics.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenants.js";
import { userRoutes } from "./routes/users.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { categoryRoutes } from "./routes/categories.js";
import { tenantSettingsRoutes } from "./routes/tenant-settings.js";

const config = getConfig();

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  },
});

async function start() {
  // Core plugins
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max
  await app.register(authPlugin);
  await app.register(metricsPlugin);

  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Ready check (verifies dependencies)
  app.get("/ready", async () => {
    return { status: "ready", version: "1.0.0" };
  });

  // API routes
  await app.register(authRoutes);
  await app.register(tenantRoutes);
  await app.register(userRoutes);
  await app.register(pipelineRoutes);
  await app.register(categoryRoutes);
  await app.register(tenantSettingsRoutes);

  // Start metrics server on separate port
  await startMetricsServer();

  // Start
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(`API server running on ${config.API_HOST}:${config.API_PORT}`);
}

// Graceful shutdown
async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down...`);
  await stopMetricsServer();
  await app.close();
  await closeAllQueues();
  await disconnectDb();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
