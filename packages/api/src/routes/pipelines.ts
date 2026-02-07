import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { getDb } from "@exams2quiz/shared/db";
import { addJob } from "@exams2quiz/shared/queue";
import { PipelineStage, BATCH_DEFAULTS } from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { mkdir, writeFile, rm, readFile, readdir, copyFile } from "node:fs/promises";
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

      // Check concurrent pipeline limit (exclude batch children — they're internal)
      const activePipelines = await db.pipelineRun.count({
        where: { tenantId, status: { in: ["QUEUED", "RUNNING"] }, parentRunId: null },
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

      // Determine if this should be a batch run
      const isBatch = allPdfPaths.length > BATCH_DEFAULTS.BATCH_SIZE;

      if (isBatch) {
        // ─── Batch Mode: fan-out into child runs ──────────────────
        const batchSize = BATCH_DEFAULTS.BATCH_SIZE;
        const chunks: { filenames: string[]; pdfPaths: string[] }[] = [];
        for (let i = 0; i < allPdfPaths.length; i += batchSize) {
          chunks.push({
            filenames: allFilenames.slice(i, i + batchSize),
            pdfPaths: allPdfPaths.slice(i, i + batchSize),
          });
        }

        if (chunks.length > BATCH_DEFAULTS.MAX_BATCHES) {
          await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
          return reply.code(400).send({
            error: `Too many documents: ${allPdfPaths.length} PDFs would create ${chunks.length} batches (max ${BATCH_DEFAULTS.MAX_BATCHES}). Reduce to at most ${BATCH_DEFAULTS.MAX_BATCHES * batchSize} files.`,
          });
        }

        const totalBatches = chunks.length;

        // Update parent run with batch metadata
        await db.pipelineRun.update({
          where: { id: pipelineRun.id },
          data: {
            filenames: allFilenames,
            sourceUrls: allSourceUrls,
            totalPdfs: allPdfPaths.length,
            batchSize,
            totalBatches,
            currentStage: PipelineStage.BATCH_COORDINATE,
          },
        });

        // Create output dir for parent (similarity + category-split will run here)
        const parentOutputDir = join(config.OUTPUT_DIR, tenantId, pipelineRun.id);
        await mkdir(parentOutputDir, { recursive: true });

        // Create child runs and enqueue pdf-extract for each
        const childRunIds: string[] = [];
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];

          const childRun = await db.pipelineRun.create({
            data: {
              tenantId,
              status: "QUEUED",
              filenames: chunk.filenames,
              sourceUrls: [],
              currentStage: PipelineStage.PDF_EXTRACT,
              totalPdfs: chunk.filenames.length,
              parentRunId: pipelineRun.id,
              batchIndex: idx,
              batchSize,
              totalBatches,
            },
          });
          childRunIds.push(childRun.id);

          // Create child upload directory and copy PDFs
          const childUploadDir = join(config.UPLOAD_DIR, tenantId, childRun.id);
          await mkdir(childUploadDir, { recursive: true });
          const childPdfPaths: string[] = [];
          for (let j = 0; j < chunk.pdfPaths.length; j++) {
            const dest = join(childUploadDir, chunk.filenames[j]);
            await copyFile(chunk.pdfPaths[j], dest);
            childPdfPaths.push(dest);
          }

          // Create child output directory
          const childOutputDir = join(config.OUTPUT_DIR, tenantId, childRun.id);
          await mkdir(childOutputDir, { recursive: true });

          // Create PipelineJob + enqueue pdf-extract for this child
          const childJob = await db.pipelineJob.create({
            data: {
              pipelineRunId: childRun.id,
              stage: PipelineStage.PDF_EXTRACT,
              status: "PENDING",
            },
          });

          const childBullmqJobId = await addJob(PipelineStage.PDF_EXTRACT, {
            tenantId,
            pipelineRunId: childRun.id,
            pdfPaths: childPdfPaths,
            outputDir: childOutputDir,
          });

          await db.pipelineJob.update({
            where: { id: childJob.id },
            data: { bullmqJobId: childBullmqJobId },
          });
        }

        // Create batch-coordinate job on the parent
        const coordinatorJob = await db.pipelineJob.create({
          data: {
            pipelineRunId: pipelineRun.id,
            stage: PipelineStage.BATCH_COORDINATE,
            status: "PENDING",
          },
        });

        const coordinatorBullmqJobId = await addJob(PipelineStage.BATCH_COORDINATE, {
          tenantId,
          parentPipelineRunId: pipelineRun.id,
          childPipelineRunIds: childRunIds,
        });

        await db.pipelineJob.update({
          where: { id: coordinatorJob.id },
          data: { bullmqJobId: coordinatorBullmqJobId },
        });

        pipelinesStartedTotal.inc({ tenant_id: tenantId });
        pipelineFilesPerRun.observe({ tenant_id: tenantId }, allPdfPaths.length);

        return reply.code(201).send({
          id: pipelineRun.id,
          status: "QUEUED",
          currentStage: PipelineStage.BATCH_COORDINATE,
          totalPdfs: allPdfPaths.length,
          filenames: allFilenames,
          totalBatches,
          childRunIds,
          createdAt: pipelineRun.createdAt,
        });
      }

      // ─── Standard Mode: single run (≤ BATCH_SIZE PDFs) ───────────
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

  // DELETE /api/pipelines/:id/delete — permanently delete pipeline run, jobs, and files
  app.delete<{ Params: { id: string } }>("/api/pipelines/:id/delete", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      const run = await db.pipelineRun.findUnique({ where: { id: request.params.id } });
      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Only allow deleting terminal-state pipelines
      const deletableStatuses = ["COMPLETED", "FAILED", "CANCELLED"];
      if (!deletableStatuses.includes(run.status)) {
        return reply.code(400).send({
          error: `Cannot delete a ${run.status.toLowerCase()} pipeline. Only completed, failed, or cancelled pipelines can be deleted.`,
        });
      }

      // Delete pipeline jobs first (FK constraint)
      await db.pipelineJob.deleteMany({ where: { pipelineRunId: run.id } });

      // Delete pipeline run
      await db.pipelineRun.delete({ where: { id: run.id } });

      // Remove output files
      const outputDir = join(config.OUTPUT_DIR, run.tenantId, run.id);
      await rm(outputDir, { recursive: true, force: true });

      // Remove uploaded files
      const uploadDir = join(config.UPLOAD_DIR, run.tenantId, run.id);
      await rm(uploadDir, { recursive: true, force: true });

      return reply.code(204).send();
    },
  });

  // GET /api/pipelines/:id/splits — list available category split files
  app.get<{ Params: { id: string } }>("/api/pipelines/:id/splits", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      const run = await db.pipelineRun.findUnique({ where: { id: request.params.id } });
      if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      const splitDir = join(config.OUTPUT_DIR, run.tenantId, run.id, "split");
      try {
        const entries = await readdir(splitDir);
        const files = entries.filter((f) => f.endsWith(".json")).sort();
        return { files };
      } catch {
        return { files: [] };
      }
    },
  });

  // GET /api/pipelines/:id/splits/:filename — get a specific category split file
  app.get<{ Params: { id: string; filename: string } }>("/api/pipelines/:id/splits/:filename", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;
      const { filename } = request.params;

      // Validate filename to prevent path traversal
      if (!filename.endsWith(".json") || filename.includes("/") || filename.includes("..")) {
        return reply.code(400).send({ error: "Invalid filename" });
      }

      const run = await db.pipelineRun.findUnique({ where: { id: request.params.id } });
      if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      const filePath = join(config.OUTPUT_DIR, run.tenantId, run.id, "split", filename);
      try {
        const content = await readFile(filePath, "utf-8");
        return JSON.parse(content);
      } catch {
        return reply.code(404).send({ error: "Split file not found" });
      }
    },
  });

  // POST /api/pipelines/merge — merge multiple completed pipelines into a new one
  app.post<{ Body: { pipelineRunIds: string[] } }>("/api/pipelines/merge", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      if (!tenantId) {
        return reply.code(400).send({ error: "User must belong to a tenant to merge pipelines" });
      }

      const { pipelineRunIds } = request.body;

      if (!Array.isArray(pipelineRunIds) || pipelineRunIds.length < 2) {
        return reply.code(400).send({ error: "At least 2 pipeline run IDs are required" });
      }

      // Fetch all specified pipeline runs
      const runs = await db.pipelineRun.findMany({
        where: { id: { in: pipelineRunIds } },
      });

      if (runs.length !== pipelineRunIds.length) {
        return reply.code(404).send({ error: "One or more pipeline runs not found" });
      }

      // Validate all belong to the same tenant and user has access
      for (const run of runs) {
        if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
          return reply.code(403).send({ error: "Access denied to one or more pipeline runs" });
        }
        if (run.status !== "COMPLETED") {
          return reply.code(400).send({
            error: `Pipeline ${run.id} is not completed (status: ${run.status.toLowerCase()}). Only completed pipelines can be merged.`,
          });
        }
      }

      // All runs should belong to the same tenant
      const runTenantId = runs[0].tenantId;
      if (!runs.every((r) => r.tenantId === runTenantId)) {
        return reply.code(400).send({ error: "All pipeline runs must belong to the same tenant" });
      }

      // Read and merge parsed.json from each pipeline run
      const mergedQuestions: unknown[] = [];
      const sourceFilenames: string[] = [];

      for (const run of runs) {
        const parsedPath = join(config.OUTPUT_DIR, run.tenantId, run.id, "parsed.json");
        try {
          const content = await readFile(parsedPath, "utf-8");
          const parsed = JSON.parse(content) as unknown[];
          mergedQuestions.push(...parsed);
        } catch {
          return reply.code(400).send({
            error: `Could not read parsed data from pipeline ${run.id}. Its output files may have been deleted.`,
          });
        }
        const filenames = (run.filenames as string[] | null) ?? [];
        sourceFilenames.push(...filenames);
      }

      if (mergedQuestions.length === 0) {
        return reply.code(400).send({ error: "No questions found in the selected pipelines" });
      }

      // Create new pipeline run starting at categorize stage
      const newRun = await db.pipelineRun.create({
        data: {
          tenantId: runTenantId,
          status: "QUEUED",
          filenames: sourceFilenames,
          sourceUrls: [],
          currentStage: PipelineStage.CATEGORIZE,
          totalPdfs: sourceFilenames.length,
          totalQuestions: mergedQuestions.length,
        },
      });

      // Create output directory and write merged parsed.json
      const outputDir = join(config.OUTPUT_DIR, runTenantId, newRun.id);
      await mkdir(outputDir, { recursive: true });

      const parsedPath = join(outputDir, "parsed.json");
      await writeFile(parsedPath, JSON.stringify(mergedQuestions, null, 2));

      // Create pipeline job record for categorize stage
      const job = await db.pipelineJob.create({
        data: {
          pipelineRunId: newRun.id,
          stage: PipelineStage.CATEGORIZE,
          status: "PENDING",
        },
      });

      // Enqueue categorize job
      const categorizedPath = join(outputDir, "categorized.json");
      const bullmqJobId = await addJob(PipelineStage.CATEGORIZE, {
        tenantId: runTenantId,
        pipelineRunId: newRun.id,
        parsedQuestionsPath: parsedPath,
        outputPath: categorizedPath,
      });

      // Update job with BullMQ ID
      await db.pipelineJob.update({
        where: { id: job.id },
        data: { bullmqJobId },
      });

      pipelinesStartedTotal.inc({ tenant_id: runTenantId });

      return reply.code(201).send({
        id: newRun.id,
        status: "QUEUED",
        currentStage: PipelineStage.CATEGORIZE,
        totalQuestions: mergedQuestions.length,
        filenames: sourceFilenames,
        mergedFrom: pipelineRunIds,
        createdAt: newRun.createdAt,
      });
    },
  });
}
