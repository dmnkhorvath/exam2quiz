import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { getConfig } from "@exams2quiz/shared/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export async function questionRoutes(app: FastifyInstance) {
  // GET /api/questions?pipelineRunId=X — read output JSON for a completed pipeline run
  app.get<{
    Querystring: { pipelineRunId: string };
  }>("/api/questions", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;
      const { pipelineRunId } = request.query;

      if (!pipelineRunId) {
        return reply.code(400).send({ error: "pipelineRunId query parameter is required" });
      }

      const run = await db.pipelineRun.findUnique({
        where: { id: pipelineRunId },
      });

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Tenant scoping
      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Try to find the best available output file (most processed first)
      const outputDir = join(config.OUTPUT_DIR, run.tenantId, run.id);
      const candidates = ["similarity.json", "categorized.json", "parsed.json"];

      for (const filename of candidates) {
        const filePath = join(outputDir, filename);
        if (existsSync(filePath)) {
          const content = await readFile(filePath, "utf-8");
          const questions = JSON.parse(content);
          return {
            pipelineRunId: run.id,
            source: filename.replace(".json", ""),
            count: Array.isArray(questions) ? questions.length : 0,
            questions,
          };
        }
      }

      // Check subdirectories (pdf-extract creates subdirs per PDF)
      const { readdirSync } = await import("node:fs");
      if (existsSync(outputDir)) {
        const entries = readdirSync(outputDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDir = join(outputDir, entry.name);
            for (const filename of candidates) {
              const filePath = join(subDir, filename);
              if (existsSync(filePath)) {
                const content = await readFile(filePath, "utf-8");
                const questions = JSON.parse(content);
                return {
                  pipelineRunId: run.id,
                  source: filename.replace(".json", ""),
                  count: Array.isArray(questions) ? questions.length : 0,
                  questions,
                };
              }
            }
          }
        }
      }

      return reply.code(404).send({ error: "No question data found for this pipeline run" });
    },
  });
}
