import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { getDb } from "@exams2quiz/shared/db";
import { addJob } from "@exams2quiz/shared/queue";
import { PipelineStage, BATCH_DEFAULTS } from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { mkdir, writeFile, rm, readFile, readdir, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
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
      const { role, tenantId: jwtTenantId } = request.user;

      const allFilenames: string[] = [];
      const allPdfPaths: string[] = [];
      const allSourceUrls: string[] = [];
      let urlsText = "";
      let formTenantId = "";

      // Process multipart parts (files + fields) first to extract tenantId field.
      // File streams MUST be consumed during iteration — @fastify/multipart drains
      // them before yielding the next part, so we read into Buffers here and write
      // to disk once we know the target tenantId / upload directory.
      const parts = request.parts();
      const fileParts: { filename: string; mimetype: string; data: Buffer }[] = [];
      for await (const part of parts) {
        if (part.type === "file") {
          const filePart = part as MultipartFile;
          const data = await filePart.toBuffer();
          fileParts.push({ filename: filePart.filename, mimetype: filePart.mimetype, data });
        } else {
          if (part.fieldname === "urls") {
            urlsText = (part as { value: string }).value;
          } else if (part.fieldname === "tenantId") {
            formTenantId = (part as { value: string }).value;
          }
        }
      }

      // For SUPER_ADMIN, use tenantId from form data; otherwise use JWT tenantId
      const tenantId = role === "SUPER_ADMIN" && formTenantId ? formTenantId : jwtTenantId;

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

      // Write buffered file parts to disk
      for (const filePart of fileParts) {
        if (filePart.mimetype !== "application/pdf") {
          await db.pipelineRun.delete({ where: { id: pipelineRun.id } });
          return reply.code(400).send({ error: `File "${filePart.filename}" is not a PDF` });
        }

        const pdfPath = join(uploadDir, filePart.filename);
        await writeFile(pdfPath, filePart.data);

        allFilenames.push(filePart.filename);
        allPdfPaths.push(pdfPath);
        filesDownloadedTotal.inc({ tenant_id: tenantId, source: "upload" });
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
    Querystring: { status?: string; limit?: number; offset?: number; tenantId?: string };
  }>("/api/pipelines", {
    preHandler: [app.authenticate],
    handler: async (request) => {
      const db = getDb();
      const { role, tenantId } = request.user;
      const { status, limit = 20, offset = 0, tenantId: filterTenantId } = request.query;

      const where: Record<string, unknown> = {};
      if (role !== "SUPER_ADMIN") {
        where.tenantId = tenantId;
      } else if (filterTenantId) {
        where.tenantId = filterTenantId;
      }
      if (status) {
        where.status = status.toUpperCase();
      }
      // Hide batch children from the top-level list — they appear under their parent
      where.parentRunId = null;

      const [runs, total] = await Promise.all([
        db.pipelineRun.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: Math.min(limit, 100),
          skip: offset,
          include: {
            tenant: { select: { name: true, slug: true } },
            childRuns: {
              orderBy: { batchIndex: "asc" },
              select: {
                id: true,
                status: true,
                currentStage: true,
                batchIndex: true,
                errorMessage: true,
                filenames: true,
              },
            },
          },
        }),
        db.pipelineRun.count({ where }),
      ]);

      // Map errorMessage -> error for frontend compatibility
      const data = runs.map(({ errorMessage, childRuns, ...rest }) => ({
        ...rest,
        error: errorMessage ?? null,
        childRuns: childRuns.map(({ errorMessage: childErr, ...childRest }) => ({
          ...childRest,
          error: childErr ?? null,
        })),
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
          childRuns: {
            orderBy: { batchIndex: "asc" },
            select: {
              id: true,
              status: true,
              currentStage: true,
              batchIndex: true,
              errorMessage: true,
              filenames: true,
            },
          },
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
      const { errorMessage, jobs, childRuns, ...rest } = run;
      return {
        ...rest,
        error: errorMessage ?? null,
        jobs: jobs?.map(({ errorMessage: jobError, ...jobRest }) => ({
          ...jobRest,
          error: jobError ?? null,
        })),
        childRuns: childRuns.map(({ errorMessage: childErr, ...childRest }) => ({
          ...childRest,
          error: childErr ?? null,
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

  // POST /api/pipelines/:id/restart — restart pipeline from scratch, clearing all data except uploaded documents
  app.post<{ Params: { id: string } }>("/api/pipelines/:id/restart", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      const run = await db.pipelineRun.findUnique({
        where: { id: request.params.id },
        include: { childRuns: true },
      });
      if (!run) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Only allow restarting terminal-state pipelines
      const restartableStatuses = ["COMPLETED", "FAILED", "CANCELLED"];
      if (!restartableStatuses.includes(run.status)) {
        return reply.code(400).send({
          error: `Cannot restart a ${run.status.toLowerCase()} pipeline. Only completed, failed, or cancelled pipelines can be restarted.`,
        });
      }

      // Cannot restart batch children directly — restart the parent instead
      if (run.parentRunId) {
        return reply.code(400).send({
          error: "Cannot restart a batch child run. Restart the parent batch pipeline instead.",
        });
      }

      const isBatchParent = run.childRuns.length > 0;

      // Delete questions created by this pipeline run (and child runs)
      const runIds = [run.id, ...run.childRuns.map((c) => c.id)];
      await db.question.deleteMany({
        where: { pipelineRunId: { in: runIds } },
      });

      // Delete all pipeline jobs for this run and child runs
      await db.pipelineJob.deleteMany({
        where: { pipelineRunId: { in: runIds } },
      });

      // Remove output files for this run and child runs
      for (const rid of runIds) {
        const outputDir = join(config.OUTPUT_DIR, run.tenantId, rid);
        await rm(outputDir, { recursive: true, force: true });
      }

      // For batch parents: delete child runs, then recreate the batch structure
      if (isBatchParent) {
        // Delete child runs from DB
        await db.pipelineRun.deleteMany({
          where: { parentRunId: run.id },
        });

        // Remove child upload dirs (they have copies of PDFs)
        for (const child of run.childRuns) {
          const childUploadDir = join(config.UPLOAD_DIR, run.tenantId, child.id);
          await rm(childUploadDir, { recursive: true, force: true });
        }

        // Reconstruct batch: read files from the parent upload dir
        const uploadDir = join(config.UPLOAD_DIR, run.tenantId, run.id);
        const allFilenames = (run.filenames as string[]) ?? [];
        const allPdfPaths = allFilenames.map((f) => join(uploadDir, f));
        const batchSize = run.batchSize ?? BATCH_DEFAULTS.BATCH_SIZE;

        const chunks: { filenames: string[]; pdfPaths: string[] }[] = [];
        for (let i = 0; i < allPdfPaths.length; i += batchSize) {
          chunks.push({
            filenames: allFilenames.slice(i, i + batchSize),
            pdfPaths: allPdfPaths.slice(i, i + batchSize),
          });
        }
        const totalBatches = chunks.length;

        // Reset parent run
        await db.pipelineRun.update({
          where: { id: run.id },
          data: {
            status: "QUEUED",
            currentStage: PipelineStage.BATCH_COORDINATE,
            processedPdfs: 0,
            totalQuestions: 0,
            errorMessage: null,
            startedAt: null,
            completedAt: null,
            batchSize,
            totalBatches,
          },
        });

        // Create parent output dir
        const parentOutputDir = join(config.OUTPUT_DIR, run.tenantId, run.id);
        await mkdir(parentOutputDir, { recursive: true });

        // Recreate child runs
        const childRunIds: string[] = [];
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];

          const childRun = await db.pipelineRun.create({
            data: {
              tenantId: run.tenantId,
              status: "QUEUED",
              filenames: chunk.filenames,
              sourceUrls: [],
              currentStage: PipelineStage.PDF_EXTRACT,
              totalPdfs: chunk.filenames.length,
              parentRunId: run.id,
              batchIndex: idx,
              batchSize,
              totalBatches,
            },
          });
          childRunIds.push(childRun.id);

          // Create child upload dir and copy PDFs
          const childUploadDir = join(config.UPLOAD_DIR, run.tenantId, childRun.id);
          await mkdir(childUploadDir, { recursive: true });
          const childPdfPaths: string[] = [];
          for (let j = 0; j < chunk.pdfPaths.length; j++) {
            const dest = join(childUploadDir, chunk.filenames[j]);
            await copyFile(chunk.pdfPaths[j], dest);
            childPdfPaths.push(dest);
          }

          // Create child output dir
          const childOutputDir = join(config.OUTPUT_DIR, run.tenantId, childRun.id);
          await mkdir(childOutputDir, { recursive: true });

          // Create PipelineJob + enqueue pdf-extract
          const childJob = await db.pipelineJob.create({
            data: {
              pipelineRunId: childRun.id,
              stage: PipelineStage.PDF_EXTRACT,
              status: "PENDING",
            },
          });

          const childBullmqJobId = await addJob(PipelineStage.PDF_EXTRACT, {
            tenantId: run.tenantId,
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
            pipelineRunId: run.id,
            stage: PipelineStage.BATCH_COORDINATE,
            status: "PENDING",
          },
        });

        const coordinatorBullmqJobId = await addJob(PipelineStage.BATCH_COORDINATE, {
          tenantId: run.tenantId,
          parentPipelineRunId: run.id,
          childPipelineRunIds: childRunIds,
        });

        await db.pipelineJob.update({
          where: { id: coordinatorJob.id },
          data: { bullmqJobId: coordinatorBullmqJobId },
        });

        pipelinesStartedTotal.inc({ tenant_id: run.tenantId });

        return reply.code(200).send({
          id: run.id,
          status: "QUEUED",
          currentStage: PipelineStage.BATCH_COORDINATE,
          totalBatches,
          childRunIds,
        });
      }

      // Standard (non-batch) restart
      // Reset run
      await db.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "QUEUED",
          currentStage: PipelineStage.PDF_EXTRACT,
          processedPdfs: 0,
          totalQuestions: 0,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });

      // Create output directory
      const outputDir = join(config.OUTPUT_DIR, run.tenantId, run.id);
      await mkdir(outputDir, { recursive: true });

      // Re-enqueue pdf-extract
      const uploadDir = join(config.UPLOAD_DIR, run.tenantId, run.id);
      const allFilenames = (run.filenames as string[]) ?? [];
      const allPdfPaths = allFilenames.map((f) => join(uploadDir, f));

      const job = await db.pipelineJob.create({
        data: {
          pipelineRunId: run.id,
          stage: PipelineStage.PDF_EXTRACT,
          status: "PENDING",
        },
      });

      const bullmqJobId = await addJob(PipelineStage.PDF_EXTRACT, {
        tenantId: run.tenantId,
        pipelineRunId: run.id,
        pdfPaths: allPdfPaths,
        outputDir,
      });

      await db.pipelineJob.update({
        where: { id: job.id },
        data: { bullmqJobId },
      });

      pipelinesStartedTotal.inc({ tenant_id: run.tenantId });

      return reply.code(200).send({
        id: run.id,
        status: "QUEUED",
        currentStage: PipelineStage.PDF_EXTRACT,
        totalPdfs: allPdfPaths.length,
        filenames: allFilenames,
      });
    },
  });

  // GET /api/pipelines/:id/categorized — download categorized.json for manual similarity processing
  app.get<{ Params: { id: string } }>("/api/pipelines/:id/categorized", {
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

      // Check if pipeline is at the MANUAL_SIMILARITY_UPLOAD stage
      if (run.currentStage !== PipelineStage.MANUAL_SIMILARITY_UPLOAD) {
        return reply.code(400).send({ error: "Pipeline must be at manual similarity upload stage" });
      }

      const categorizedPath = join(config.OUTPUT_DIR, run.tenantId, run.id, "categorized_merged.json");
      try {
        const content = await readFile(categorizedPath, "utf-8");
        reply.header("Content-Disposition", `attachment; filename="categorized_${run.id}.json"`);
        reply.header("Content-Type", "application/json");
        return reply.send(content);
      } catch {
        return reply.code(404).send({ error: "Categorized file not found" });
      }
    },
  });

  // POST /api/pipelines/:id/similarity-url — submit similarity result URL and resume pipeline
  app.post<{ Params: { id: string }; Body: { url: string } }>("/api/pipelines/:id/similarity-url", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;
      const { url } = request.body;

      if (!url || typeof url !== "string") {
        return reply.code(400).send({ error: "URL is required" });
      }

      const run = await db.pipelineRun.findUnique({ where: { id: request.params.id } });
      if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
      if (role !== "SUPER_ADMIN" && run.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Pipeline run not found" });
      }

      // Check if pipeline is at the MANUAL_SIMILARITY_UPLOAD stage
      if (run.currentStage !== PipelineStage.MANUAL_SIMILARITY_UPLOAD) {
        return reply.code(400).send({ error: "Pipeline must be at manual similarity upload stage" });
      }

      // Download the similarity JSON from the provided URL
      const outputDir = join(config.OUTPUT_DIR, run.tenantId, run.id);
      const similarityPath = join(outputDir, "similarity.json");

      try {
        const response = await fetch(url);

        if (!response.ok) {
          return reply.code(400).send({ error: `Failed to download file: ${response.statusText}` });
        }

        const content = await response.text();

        // Validate it's valid JSON with expected structure
        try {
          const parsed = JSON.parse(content);
          if (!Array.isArray(parsed)) {
            return reply.code(400).send({ error: "Invalid similarity result format: expected array" });
          }
        } catch {
          return reply.code(400).send({ error: "Invalid JSON format" });
        }

        // Write the similarity result to the expected location
        await writeFile(similarityPath, content, "utf-8");

        // Enqueue category-split stage
        const nextJobData = {
          tenantId: run.tenantId,
          pipelineRunId: run.id,
          inputPath: similarityPath,
          outputDir: join(outputDir, "split"),
        };

        await addJob(
          PipelineStage.CATEGORY_SPLIT,
          nextJobData as unknown as Record<string, unknown>,
        );

        // Create job record
        await db.pipelineJob.create({
          data: {
            pipelineRunId: run.id,
            stage: PipelineStage.CATEGORY_SPLIT,
            status: "PENDING",
          },
        });

        // Update pipeline run status
        await db.pipelineRun.update({
          where: { id: run.id },
          data: {
            status: "RUNNING",
            currentStage: PipelineStage.CATEGORY_SPLIT,
          },
        });

        return { success: true, message: "Similarity result uploaded, pipeline resumed" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return reply.code(500).send({ error: `Failed to process similarity URL: ${message}` });
      }
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
        const isBatchParent = (run.totalBatches ?? 0) > 0;

        if (isBatchParent) {
          // Batch parent: read parsed.json from each child run
          const childRuns = await db.pipelineRun.findMany({
            where: { parentRunId: run.id, status: "COMPLETED" },
            orderBy: { batchIndex: "asc" },
          });
          if (childRuns.length === 0) {
            return reply.code(400).send({
              error: `Batch pipeline ${run.id} has no completed child runs.`,
            });
          }
          for (const child of childRuns) {
            const parsedPath = join(config.OUTPUT_DIR, child.tenantId, child.id, "parsed.json");
            try {
              const content = await readFile(parsedPath, "utf-8");
              const parsed = JSON.parse(content) as unknown[];
              mergedQuestions.push(...parsed);
            } catch {
              return reply.code(400).send({
                error: `Could not read parsed data from batch child ${child.id} of pipeline ${run.id}. Its output files may have been deleted.`,
              });
            }
          }
        } else {
          // Standard run: read parsed.json directly
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
