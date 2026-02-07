import { type Job, type Worker } from "bullmq";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  PipelineStage,
  type CategorySplitJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent, trackPipelineRunCompleted } from "../metrics.js";

// ─── Hungarian → English transliteration map ─────────────────────
const HU_TO_EN: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ö: "o", ő: "o",
  ú: "u", ü: "u", ű: "u",
  Á: "A", É: "E", Í: "I", Ó: "O", Ö: "O", Ő: "O",
  Ú: "U", Ü: "U", Ű: "U",
};

// ─── Helpers ─────────────────────────────────────────────────────

/** Replace Hungarian accented characters with English equivalents. */
export function transliterate(text: string): string {
  let result = text;
  for (const [hu, en] of Object.entries(HU_TO_EN)) {
    result = result.replaceAll(hu, en);
  }
  return result;
}

/** Convert category name to a safe, lowercase filename (no extension). */
export function sanitizeFilename(name: string): string {
  let safe = transliterate(name);
  safe = safe.replace(/[^a-zA-Z0-9\s-]/g, "");
  safe = safe.replace(/\s+/g, "_");
  return safe.toLowerCase();
}

/**
 * Group questions by similarity_group_id.
 * Questions with null/undefined similarity_group_id each get their own group.
 */
export function groupBySimilarity<T extends { similarity_group_id?: string | null }>(
  items: T[],
): T[][] {
  const groups = new Map<string, T[]>();
  let nullCounter = 0;

  for (const item of items) {
    const groupId = item.similarity_group_id;

    if (groupId == null) {
      groups.set(`__null_${nullCounter}`, [item]);
      nullCounter++;
    } else {
      const existing = groups.get(groupId);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(groupId, [item]);
      }
    }
  }

  return Array.from(groups.values());
}

// ─── Types for input data ────────────────────────────────────────
interface SimilarityOutputEntry {
  file: string;
  success: boolean;
  data?: Record<string, unknown>;
  source_folder?: string;
  categorization?: {
    success: boolean;
    category?: string;
    reasoning?: string;
  };
  similarity_group_id?: string | null;
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processCategorySplit(
  job: Job<CategorySplitJobData>,
): Promise<{
  totalQuestions: number;
  categoriesWritten: number;
  skippedQuestions: number;
  outputDir: string;
}> {
  const { tenantId, pipelineRunId, inputPath, outputDir } = job.data;
  const db = getDb();

  logStageEvent("category-split", "info", "job_started", `Processing ${inputPath}`, { tenantId, pipelineRunId });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.CATEGORY_SPLIT },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    // Read similarity output (final merged data from previous stages)
    const raw = await readFile(inputPath, "utf-8");
    const data: SimilarityOutputEntry[] = JSON.parse(raw);

    await job.updateProgress(10);

    // Group by category
    const categories = new Map<string, SimilarityOutputEntry[]>();
    let skipped = 0;

    for (const item of data) {
      const category = item.categorization?.category;
      if (!category) {
        skipped++;
        continue;
      }

      const existing = categories.get(category);
      if (existing) {
        existing.push(item);
      } else {
        categories.set(category, [item]);
      }
    }

    logStageEvent("category-split", "info", "categories_grouped", `${categories.size} categories, ${skipped} skipped`, { categoryCount: categories.size, skippedCount: skipped });
    if (skipped > 0) {
      logStageEvent("category-split", "warn", "questions_without_category", `${skipped} questions had no category`, { skippedCount: skipped });
    }

    await job.updateProgress(30);

    // Create output directory
    await mkdir(outputDir, { recursive: true });

    // Write separate file per category
    const sortedCategories = [...categories.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    let written = 0;
    for (const [categoryName, items] of sortedCategories) {
      const filename = `${sanitizeFilename(categoryName)}.json`;
      const outputPath = path.join(outputDir, filename);

      const grouped = groupBySimilarity(items);

      const outputData = {
        category_name: categoryName,
        groups: grouped,
      };

      await writeFile(
        outputPath,
        JSON.stringify(outputData, null, 2),
        "utf-8",
      );

      written++;
      const progress = 30 + Math.round((written / sortedCategories.length) * 60);
      await job.updateProgress(progress);
      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.CATEGORY_SPLIT },
        data: { progress },
      });

      logStageEvent("category-split", "info", "category_written", `${categoryName}: ${items.length} questions, ${grouped.length} groups`, { category: categoryName, questionCount: items.length, groupCount: grouped.length });
    }

    await job.updateProgress(95);

    const result = {
      totalQuestions: data.length,
      categoriesWritten: written,
      skippedQuestions: skipped,
      outputDir,
    };

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.CATEGORY_SPLIT },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result,
      },
    });

    // ─── Persist similarity_group_id back to DB ──────────────────
    logStageEvent("category-split", "info", "updating_similarity_ids", `Updating similarity group IDs for ${data.length} questions`, { tenantId, pipelineRunId });
    for (const item of data) {
      await db.question.update({
        where: { tenantId_file: { tenantId, file: item.file } },
        data: { similarityGroupId: item.similarity_group_id ?? null },
      });
    }

    // This is the FINAL pipeline stage — mark the PipelineRun as completed
    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    trackPipelineRunCompleted("completed");

    await job.updateProgress(100);

    logStageEvent("category-split", "info", "job_completed", `${written} categories written, pipeline run completed`, { pipelineRunId, categoriesWritten: written, totalQuestions: data.length });
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("category-split", "error", "job_failed", errorMsg, { pipelineRunId });
    trackPipelineRunCompleted("failed");

    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.CATEGORY_SPLIT },
      data: {
        status: "FAILED",
        errorMessage: errorMsg,
      },
    });

    // Mark pipeline run as failed
    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { status: "FAILED", errorMessage: errorMsg },
    });

    throw err;
  }
}

// ─── Worker Registration ──────────────────────────────────────────
export function createCategorySplitWorker(): Worker<CategorySplitJobData> {
  const config = getConfig();
  const worker = createWorker<CategorySplitJobData>(
    PipelineStage.CATEGORY_SPLIT,
    processCategorySplit,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[category-split] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[category-split] Job ${job?.id} failed:`, err.message);
  });

  console.log("[category-split] Worker registered");
  return worker;
}
