import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { addJob } from "@exams2quiz/shared/queue";
import { PipelineStage } from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function pipelineRoutes(app: FastifyInstance) {
  // POST /api/pipelines — start a new pipeline run (with PDF upload)
  app.post("/api/pipelines", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { tenantId } = request.user;

      if (!tenantId) {
        return reply.code(400).send({ error: "User must belong to a tenant to start pipelines" });
      }

      // Check tenant is active
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant || !tenant.isActive) {
        return reply.code(403).send({ error: "Tenant is inactive" });
      }

      // Check concurrent pipeline limit
      const activePipelines = await db.pipelineRun.count({
        where: { tenantId, status: { in: ["QUEUED", "RUNNING"] } },
      });
      if (activePipelines >= tenant.maxConcurrentPipelines) {
        return reply.code(429).send({ error: "Maximum concurrent pipelines reached" });
      }

      // Handle file upload
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: "PDF file is required" });
      }
      if (file.mimetype !== "application/pdf") {
        return reply.code(400).send({ error: "Only PDF files are accepted" });
      }

      // Create pipeline run
      const pipelineRun = await db.pipelineRun.create({
        data: {
          tenantId,
          status: "QUEUED",
          filename: file.filename,
          currentStage: PipelineStage.PDF_EXTRACT,
          totalPdfs: 1,
        },
      });

      // Save uploaded PDF
      const uploadDir = join(config.UPLOAD_DIR, tenantId, pipelineRun.id);
      await mkdir(uploadDir, { recursive: true });
      const pdfPath = join(uploadDir, file.filename);

      const { createWriteStream } = await import("node:fs");
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(pdfPath);
        file.file.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
      });

      // Create pipeline job record
      const job = await db.pipelineJob.create({
        data: {
          pipelineRunId: pipelineRun.id,
          stage: PipelineStage.PDF_EXTRACT,
          status: "PENDING",
        },
      });

      // Enqueue to BullMQ
      const outputDir = join(config.OUTPUT_DIR, tenantId, pipelineRun.id);
      await mkdir(outputDir, { recursive: true });

      const bullmqJobId = await addJob(PipelineStage.PDF_EXTRACT, {
        tenantId,
        pipelineRunId: pipelineRun.id,
        pdfPath,
        outputDir,
      });

      // Update job with BullMQ ID
      await db.pipelineJob.update({
        where: { id: job.id },
        data: { bullmqJobId },
      });

      return reply.code(201).send({
        id: pipelineRun.id,
        status: pipelineRun.status,
        currentStage: pipelineRun.currentStage,
        createdAt: pipelineRun.createdAt,
      });
    },
  });

  // GET /api/pipelines — list pipeline runs for current tenant
  app.get<{
    Querystring: { status?: string; limit?: number; offset?: number };
  }>("/api/pipelines", {
    preHandler: [app.authenticate],
    handler: async (request) => {
      const db = getDb();
      const { role, tenantId } = request.user;
      const { status, limit = 20, offset = 0 } = request.query;

      const where: Record<string, unknown> = {};
      if (role !== "SUPER_ADMIN") {
        where.tenantId = tenantId;
      }
      if (status) {
        where.status = status.toUpperCase();
      }

      const [runs, total] = await Promise.all([
        db.pipelineRun.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: Math.min(limit, 100),
          skip: offset,
          include: { tenant: { select: { name: true, slug: true } } },
        }),
        db.pipelineRun.count({ where }),
      ]);

      // Map errorMessage -> error for frontend compatibility
      const data = runs.map(({ errorMessage, ...rest }) => ({
        ...rest,
        error: errorMessage ?? null,
      }));

      return { data, total, limit, offset };
    },
  });

  // GET /api/pipelines/:id — get pipeline run details
  app.get<{ Params: { id: string } }>("/api/pipelines/:id", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const run = await db.pipelineRun.findUnique({
        where: { id: request.params.id },
        include: {
          jobs: { orderBy: { createdAt: "asc" } },
          tenant: { select: { name: true, slug: true } },
        },
      });

      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Tenant scoping
      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Map errorMessage -> error for frontend compatibility
      const { errorMessage, jobs, ...rest } = run;
      return {
        ...rest,
        error: errorMessage ?? null,
        jobs: jobs?.map(({ errorMessage: jobError, ...jobRest }) => ({
          ...jobRest,
          error: jobError ?? null,
        })),
      };
    },
  });

  // DELETE /api/pipelines/:id — cancel pipeline run
  app.delete<{ Params: { id: string } }>("/api/pipelines/:id", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const run = await db.pipelineRun.findUnique({ where: { id: request.params.id } });
      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      if (run.status === "COMPLETED" || run.status === "CANCELLED") {
        return reply.code(400).send({ error: `Cannot cancel a ${run.status.toLowerCase()} pipeline` });
      }

      await db.pipelineRun.update({
        where: { id: request.params.id },
        data: { status: "CANCELLED", completedAt: new Date() },
      });

      return reply.code(204).send();
    },
  });
}
