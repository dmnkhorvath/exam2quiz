import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { getConfig } from "@exams2quiz/shared/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export async function questionRoutes(app: FastifyInstance) {
  // GET /api/questions?pipelineRunId=xxx — list questions from a completed pipeline run
  app.get<{ Querystring: { pipelineRunId: string } }>("/api/questions", {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: "object",
        required: ["pipelineRunId"],
        properties: {
          pipelineRunId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;
      const { pipelineRunId } = request.query;

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

      // Try to read the most complete question data available
      // Priority: similarity.json > categorized.json > parsed.json
      const outputDir = join(config.OUTPUT_DIR, run.tenantId, pipelineRunId);
      const candidates = ["similarity.json", "categorized.json", "parsed.json"];

      for (const filename of candidates) {
        const filePath = join(outputDir, filename);
        if (existsSync(filePath)) {
          try {
            const raw = await readFile(filePath, "utf-8");
            const questions = JSON.parse(raw);
            return {
              pipelineRunId,
              source: filename,
              count: Array.isArray(questions) ? questions.length : 0,
              questions,
            };
          } catch {
            return reply.code(500).send({ error: `Failed to read ${filename}` });
          }
        }
      }

      return reply.code(404).send({
        error: "No question data available yet. Pipeline may still be processing.",
      });
    },
  });
}
