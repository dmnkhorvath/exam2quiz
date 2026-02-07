import { type Job, type Worker } from "bullmq";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PipelineStage,
  BATCH_DEFAULTS,
  type BatchCoordinatorJobData,
  type SimilarityJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent } from "../metrics.js";

// ─── Types ────────────────────────────────────────────────────────
interface CategorizedQuestionEntry {
  file: string;
  success: boolean;
  source_folder?: string;
  data?: {
    question_number: string;
    points: number;
    question_text: string;
    question_type: string;
    correct_answer: string;
    options?: string[];
  };
  categorization: {
    success: boolean;
    category?: string;
    reasoning?: string;
    error?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processBatchCoordinate(
  job: Job<BatchCoordinatorJobData>,
): Promise<{
  childrenCompleted: number;
  childrenFailed: number;
  totalQuestions: number;
}> {
  const { tenantId, parentPipelineRunId, childPipelineRunIds } = job.data;
  const db = getDb();
  const config = getConfig();

  const pollInterval = BATCH_DEFAULTS.COORDINATOR_POLL_INTERVAL;
  const timeout = BATCH_DEFAULTS.COORDINATOR_TIMEOUT;
  const totalChildren = childPipelineRunIds.length;

  logStageEvent("batch-coordinate", "info", "job_started", `Coordinating ${totalChildren} child runs for parent ${parentPipelineRunId}`, { tenantId, parentPipelineRunId, totalChildren });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  // Update parent run status to RUNNING
  await db.pipelineRun.update({
    where: { id: parentPipelineRunId },
    data: { status: "RUNNING" },
  });

  try {
    const startTime = Date.now();
    let pollCount = 0;

    while (true) {
      // Check timeout
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        const errorMsg = `Batch coordinator timed out after ${Math.round(elapsed / 1000 / 60)} minutes. ${totalChildren} children were being monitored.`;
        logStageEvent("batch-coordinate", "error", "timeout", errorMsg, { parentPipelineRunId, elapsed });

        await db.pipelineJob.updateMany({
          where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
          data: { status: "FAILED", errorMessage: errorMsg },
        });
        await db.pipelineRun.update({
          where: { id: parentPipelineRunId },
          data: { status: "FAILED", errorMessage: errorMsg },
        });
        throw new Error(errorMsg);
      }

      // Poll child run statuses
      const childRuns = await db.pipelineRun.findMany({
        where: { id: { in: childPipelineRunIds } },
        select: { id: true, status: true, errorMessage: true },
      });

      const completed = childRuns.filter((r) => r.status === "COMPLETED").length;
      const failed = childRuns.filter((r) => r.status === "FAILED").length;
      const cancelled = childRuns.filter((r) => r.status === "CANCELLED").length;

      pollCount++;

      // Update progress to prevent BullMQ stalling
      const progress = Math.round((completed / totalChildren) * 100);
      await job.updateProgress(progress);
      await db.pipelineJob.updateMany({
        where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
        data: { progress },
      });

      // Log progress periodically (every 6th poll = ~60s)
      if (pollCount % 6 === 1) {
        logStageEvent("batch-coordinate", "info", "poll_status", `${completed}/${totalChildren} completed, ${failed} failed`, { parentPipelineRunId, completed, failed, cancelled, pollCount });
      }

      // Check for failures — if any child failed, mark parent as failed
      if (failed > 0 || cancelled > 0) {
        const failedRun = childRuns.find((r) => r.status === "FAILED" || r.status === "CANCELLED");
        const errorMsg = `Batch child run failed: ${failedRun?.id} — ${failedRun?.errorMessage ?? "unknown error"}. ${failed} failed, ${cancelled} cancelled out of ${totalChildren} children.`;
        logStageEvent("batch-coordinate", "error", "child_failed", errorMsg, { parentPipelineRunId, failedRunId: failedRun?.id });

        await db.pipelineJob.updateMany({
          where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
          data: { status: "FAILED", errorMessage: errorMsg },
        });
        await db.pipelineRun.update({
          where: { id: parentPipelineRunId },
          data: { status: "FAILED", errorMessage: errorMsg },
        });
        throw new Error(errorMsg);
      }

      // Check if all children completed
      if (completed === totalChildren) {
        logStageEvent("batch-coordinate", "info", "all_children_completed", `All ${totalChildren} children completed. Preparing similarity stage.`, { parentPipelineRunId, totalChildren });
        break;
      }

      // Wait before next poll
      await sleep(pollInterval);
    }

    // ─── All children completed: build merged dataset and enqueue similarity ──

    // Load all tenant questions from DB (children already upserted via categorize)
    const allTenantQuestions = await db.question.findMany({
      where: { tenantId },
    });

    logStageEvent("batch-coordinate", "info", "questions_loaded", `Loaded ${allTenantQuestions.length} tenant questions for similarity`, { tenantId, parentPipelineRunId, questionCount: allTenantQuestions.length });

    // Write categorized_merged.json to parent's output directory
    const mergedCategorized: CategorizedQuestionEntry[] = allTenantQuestions.map((q) => ({
      file: q.file,
      success: q.success,
      source_folder: q.sourcePdf ?? undefined,
      data: q.data as CategorizedQuestionEntry["data"],
      categorization: q.categorization as CategorizedQuestionEntry["categorization"],
    }));

    const parentOutputDir = path.join(config.OUTPUT_DIR, tenantId, parentPipelineRunId);
    const mergedPath = path.join(parentOutputDir, "categorized_merged.json");
    await writeFile(mergedPath, JSON.stringify(mergedCategorized, null, 2), "utf-8");

    const similarityOutputPath = path.join(parentOutputDir, "similarity.json");

    // Enqueue similarity on the parent run
    const nextJobData: SimilarityJobData = {
      tenantId,
      pipelineRunId: parentPipelineRunId,
      inputPath: mergedPath,
      outputPath: similarityOutputPath,
    };
    await addJob(
      PipelineStage.SIMILARITY,
      nextJobData as unknown as Record<string, unknown>,
    );
    await db.pipelineJob.create({
      data: {
        pipelineRunId: parentPipelineRunId,
        stage: PipelineStage.SIMILARITY,
        status: "PENDING",
      },
    });
    await db.pipelineRun.update({
      where: { id: parentPipelineRunId },
      data: { currentStage: PipelineStage.SIMILARITY },
    });

    // Mark coordinator job as completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result: {
          childrenCompleted: totalChildren,
          childrenFailed: 0,
          totalQuestions: allTenantQuestions.length,
        },
      },
    });

    await job.updateProgress(100);

    logStageEvent("batch-coordinate", "info", "job_completed", `Coordinator done. ${allTenantQuestions.length} questions forwarded to similarity.`, { parentPipelineRunId, totalQuestions: allTenantQuestions.length });

    return {
      childrenCompleted: totalChildren,
      childrenFailed: 0,
      totalQuestions: allTenantQuestions.length,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("batch-coordinate", "error", "job_failed", errorMsg, { parentPipelineRunId });

    // Update job status to failed (may already be set for timeout/child-failure)
    await db.pipelineJob.updateMany({
      where: { pipelineRunId: parentPipelineRunId, stage: PipelineStage.BATCH_COORDINATE },
      data: {
        status: "FAILED",
        errorMessage: errorMsg,
      },
    });

    // Mark pipeline run as failed
    await db.pipelineRun.update({
      where: { id: parentPipelineRunId },
      data: { status: "FAILED", errorMessage: errorMsg },
    });

    throw err;
  }
}

// ─── Worker Registration ──────────────────────────────────────────
export function createBatchCoordinateWorker(): Worker<BatchCoordinatorJobData> {
  const config = getConfig();
  const worker = createWorker<BatchCoordinatorJobData>(
    PipelineStage.BATCH_COORDINATE,
    processBatchCoordinate,
    {
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: BATCH_DEFAULTS.COORDINATOR_TIMEOUT,  // 4 hours — long-polling job
      stalledInterval: 30 * 60 * 1000,                   // 30 min stall check
    },
  );

  worker.on("completed", (job) => {
    console.log(`[batch-coordinate] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[batch-coordinate] Job ${job?.id} failed:`, err.message);
  });

  console.log("[batch-coordinate] Worker registered");
  return worker;
}
