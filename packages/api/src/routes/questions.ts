import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";

export async function questionRoutes(app: FastifyInstance) {
  // GET /api/questions — list all tenant questions (optionally filtered)
  app.get<{
    Querystring: {
      pipelineRunId?: string;
      category?: string;
      page?: string;
      limit?: string;
    };
  }>("/api/questions", {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: "object",
        properties: {
          pipelineRunId: { type: "string" },
          category: { type: "string" },
          page: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;
      const { pipelineRunId, category, page, limit } = request.query;

      if (!tenantId && role !== "SUPER_ADMIN") {
        return reply.code(400).send({ error: "User must belong to a tenant" });
      }

      // Build filter
      const where: Record<string, unknown> = {};

      if (role === "SUPER_ADMIN" && pipelineRunId) {
        // SUPER_ADMIN can query by pipelineRunId across tenants
        const run = await db.pipelineRun.findUnique({ where: { id: pipelineRunId } });
        if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
        where.tenantId = run.tenantId;
      } else if (tenantId) {
        where.tenantId = tenantId;
      }

      if (pipelineRunId) {
        where.pipelineRunId = pipelineRunId;
      }

      // Filter by category (stored in categorization JSON)
      if (category) {
        where.categorization = { path: ["category"], equals: category };
      }

      const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(limit ?? "100", 10) || 100));

      const [questions, total] = await Promise.all([
        db.question.findMany({
          where,
          orderBy: [{ file: "asc" }],
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
        }),
        db.question.count({ where }),
      ]);

      return {
        questions: questions.map((q) => ({
          id: q.id,
          file: q.file,
          sourcePdf: q.sourcePdf,
          success: q.success,
          data: q.data,
          categorization: q.categorization,
          similarityGroupId: q.similarityGroupId,
          pipelineRunId: q.pipelineRunId,
          createdAt: q.createdAt,
          updatedAt: q.updatedAt,
        })),
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    },
  });
}
