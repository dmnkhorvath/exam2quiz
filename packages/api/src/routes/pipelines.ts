import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { getDb } from "@exams2quiz/shared/db";
import { addJob } from "@exams2quiz/shared/queue";
import { PipelineStage } from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  pipelinesStartedTotal,
  filesDownloadedTotal,
  pipelineFilesPerRun,
  urlDownloadDurationSeconds,
} from "../plugins/metrics.js";

/**
 * Sanitize a filename derived from a URL path.
 * Strips query/hash, keeps only the basename, and falls back to a default.
 */
function filenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const name = basename(parsed.pathname);
    // Strip non-safe chars
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized && sanitized !== "_" ? sanitized : "download.pdf";
  } catch {
    return "download.pdf";
  }
}

export async function pipelineRoutes(app: FastifyInstance) {
  // POST /api/pipelines — start a new pipeline run (multi-file upload + URL download)
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

      // Create pipeline run first to get an ID for the upload directory
      const pipelineRun = await db.pipelineRun.create({
        data: {
          tenantId,
          status: "QUEUED",
          filenames: [],
          sourceUrls: [],
          currentStage: PipelineStage.PDF_EXTRACT,
          totalPdfs: 0,
        },
      });

      const uploadDir = join(config.UPLOAD_DIR, tenantId, pipelineRun.id);
      await mkdir(uploadDir, { recursive: true });

      const allFilenames: string[] = [];
      const allPdfPaths: string[] = [];
      const allSourceUrls: string[] = [];
      let urlsText = "";

      // Process multipart parts (files + fields)
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file") {
          const filePart = part as MultipartFile;
          if (filePart.mimetype !== "application/pdf") {
            // Clean up the created run on validation error
            await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
            return reply.code(400).send({ error: `File "${filePart.filename}" is not a PDF` });
          }

          const pdfPath = join(uploadDir, filePart.filename);
          await pipeline(filePart.file, createWriteStream(pdfPath));

          allFilenames.push(filePart.filename);
          allPdfPaths.push(pdfPath);
          filesDownloadedTotal.inc({ tenant_id: tenantId, source: "upload" });
        } else {
          // Field part
          if (part.fieldname === "urls") {
            urlsText = (part as { value: string }).value;
          }
        }
      }

      // Process URLs from the urls field
      if (urlsText.trim()) {
        const urls = urlsText
          .split("\n")
          .map((u) => u.trim())
          .filter((u) => u.length > 0);

        for (const rawUrl of urls) {
          // Validate URL
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(rawUrl);
            if (!parsedUrl.protocol.startsWith("http")) {
              throw new Error("Not HTTP(S)");
            }
          } catch {
            await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
            return reply.code(400).send({ error: `Invalid URL: ${rawUrl}` });
          }

          // Download the file
          const downloadStart = performance.now();
          let response: Response;
          try {
            response = await fetch(parsedUrl.href);
          } catch (err) {
            await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
            return reply.code(400).send({
              error: `Failed to download URL: ${rawUrl} — ${err instanceof Error ? err.message : "unknown error"}`,
            });
          }
          const downloadDuration = (performance.now() - downloadStart) / 1000;
          urlDownloadDurationSeconds.observe({ tenant_id: tenantId }, downloadDuration);

          if (!response.ok) {
            await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
            return reply.code(400).send({
              error: `URL returned HTTP ${response.status}: ${rawUrl}`,
            });
          }

          // Derive filename and save
          let filename = filenameFromUrl(rawUrl);
          // Ensure .pdf extension
          if (!filename.toLowerCase().endsWith(".pdf")) {
            filename += ".pdf";
          }
          // Deduplicate filenames within the same run
          let deduped = filename;
          let counter = 1;
          while (allFilenames.includes(deduped)) {
            const ext = ".pdf";
            const stem = filename.slice(0, -ext.length);
            deduped = `${stem}_${counter}${ext}`;
            counter++;
          }
          filename = deduped;

          const pdfPath = join(uploadDir, filename);
          const arrayBuffer = await response.arrayBuffer();
          await writeFile(pdfPath, Buffer.from(arrayBuffer));

          allFilenames.push(filename);
          allPdfPaths.push(pdfPath);
          allSourceUrls.push(rawUrl);
          filesDownloadedTotal.inc({ tenant_id: tenantId, source: "url" });
        }
      }

      // Validate at least one file
      if (allPdfPaths.length === 0) {
        await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
        return reply.code(400).send({ error: "At least one PDF file or URL is required" });
      }

      // Update pipeline run with actual file info
      await db.pipelineRun.update({
        where: { id: pipelineRun.id },
        data: {
          filenames: allFilenames,
          sourceUrls: allSourceUrls,
          totalPdfs: allPdfPaths.length,
        },
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
        pdfPaths: allPdfPaths,
        outputDir,
      });

      // Update job with BullMQ ID
      await db.pipelineJob.update({
        where: { id: job.id },
        data: { bullmqJobId },
      });

      pipelinesStartedTotal.inc({ tenant_id: tenantId });
      pipelineFilesPerRun.observe({ tenant_id: tenantId }, allPdfPaths.length);

      return reply.code(201).send({
        id: pipelineRun.id,
        status: "QUEUED",
        currentStage: PipelineStage.PDF_EXTRACT,
        totalPdfs: allPdfPaths.length,
        filenames: allFilenames,
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
