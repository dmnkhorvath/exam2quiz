import { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import Fastify from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from "prom-client";
import { getConfig } from "@exams2quiz/shared/config";

const register = new Registry();

collectDefaultMetrics({ register });

// ─── HTTP Request Metrics ────────────────────────────────────────
const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ─── Pipeline Metrics ────────────────────────────────────────────
export const pipelinesStartedTotal = new Counter({
  name: "pipelines_started_total",
  help: "Total number of pipelines started",
  labelNames: ["tenant_id"] as const,
  registers: [register],
});

// ─── Metrics Fastify Plugin ──────────────────────────────────────
export const metricsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Hook into every request to track metrics
  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions?.url ?? request.url;
    // Skip metrics path itself
    if (route === "/metrics") {
      done();
      return;
    }
    const method = request.method;
    const statusCode = reply.statusCode.toString();
    const duration = reply.elapsedTime / 1000; // ms → seconds

    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    httpRequestDuration.observe(
      { method, route, status_code: statusCode },
      duration,
    );
    done();
  });
};

// ─── Standalone Metrics Server ───────────────────────────────────
// Runs on a separate port so Prometheus can scrape without auth
let metricsServer: FastifyInstance | null = null;

export async function startMetricsServer(): Promise<void> {
  const config = getConfig();
  metricsServer = Fastify({ logger: false });

  metricsServer.get("/metrics", async (_request, reply) => {
    const metrics = await register.metrics();
    reply.header("Content-Type", register.contentType);
    return metrics;
  });

  metricsServer.get("/health", async () => ({ status: "ok" }));

  await metricsServer.listen({ host: "0.0.0.0", port: config.METRICS_PORT });
  console.log(`[metrics] Metrics server on port ${config.METRICS_PORT}`);
}

export async function stopMetricsServer(): Promise<void> {
  if (metricsServer) {
    await metricsServer.close();
  }
}

export { register };
