import Fastify from "fastify";
import cors from "@fastify/cors";
import { getConfig } from "@exams2quiz/shared/config";

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
  // Plugins
  await app.register(cors, { origin: true });

  // Health check
  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

  // Ready check (verifies dependencies)
  app.get("/ready", async () => {
    return { status: "ready", version: "1.0.0" };
  });

  // Start
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(`API server running on ${config.API_HOST}:${config.API_PORT}`);
}

start().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
