import { type Job, type Worker } from "bullmq";
import { readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PipelineStage,
  type SimilarityJobData,
  type CategorySplitJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent, trackSimilarityGroups } from "../metrics.js";

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────
const DEFAULT_CROSS_ENCODER_THRESHOLD = 0.7;
const DEFAULT_REFINE_THRESHOLD = 10;
const SIMILARITY_TIMEOUT_MS = Number(process.env.SIMILARITY_TIMEOUT_MS) || 60 * 60 * 1000; // default 60 min
const SIMILARITY_MAX_BUFFER = 100 * 1024 * 1024; // 100MB output buffer

// Path to the Python script (relative to repo root)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const PYTHON_SCRIPT = path.join(REPO_ROOT, "scripts/find_similar_questions.py");

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
    subcategory?: string;
    reasoning?: string;
    error?: string;
  };
  similarity_group_id?: string | null;
}

// ─── Run Python Script ────────────────────────────────────────────
async function runPythonSimilarity(
  inputPath: string,
  outputPath: string,
  crossEncoderThreshold: number,
  refineThreshold: number,
): Promise<void> {
  const args = [
    "run",
    PYTHON_SCRIPT,
    "-i", inputPath,
    "-o", outputPath,
    "--cross-encoder-threshold", String(crossEncoderThreshold),
    "--refine-threshold", String(refineThreshold),
  ];

  logStageEvent("similarity", "info", "python_start", `Running: uv ${args.join(" ")}`, {
    script: PYTHON_SCRIPT,
    crossEncoderThreshold,
    refineThreshold,
  });

  const { stdout, stderr } = await execFileAsync("uv", args, {
    cwd: REPO_ROOT,
    timeout: SIMILARITY_TIMEOUT_MS,
    maxBuffer: SIMILARITY_MAX_BUFFER,
  });

  if (stdout) {
    for (const line of stdout.split("\n").filter(Boolean)) {
      console.log(`[similarity:py] ${line}`);
    }
  }
  if (stderr) {
    for (const line of stderr.split("\n").filter(Boolean)) {
      console.warn(`[similarity:py:stderr] ${line}`);
    }
  }
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processSimilarity(
  job: Job<SimilarityJobData>,
): Promise<{
  totalQuestions: number;
  groupsFound: number;
  questionsAssigned: number;
  outputPath: string;
}> {
  const {
    tenantId,
    pipelineRunId,
    inputPath,
    outputPath,
    crossEncoderThreshold = DEFAULT_CROSS_ENCODER_THRESHOLD,
    refineThreshold = DEFAULT_REFINE_THRESHOLD,
  } = job.data;
  const db = getDb();

  logStageEvent("similarity", "info", "job_started", `Processing questions from ${inputPath}`, { tenantId, pipelineRunId });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    // Delete pre-existing similarity output and split directory for clean state
    // (important for merged pipelines that re-run similarity from scratch)
    await rm(outputPath, { force: true });
    await rm(path.join(path.dirname(outputPath), "split"), { recursive: true, force: true });

    // Load categorized questions to check count
    const raw = await readFile(inputPath, "utf-8");
    const questions: CategorizedQuestionEntry[] = JSON.parse(raw);
    const totalQuestions = questions.length;

    logStageEvent("similarity", "info", "questions_loaded", `Loaded ${totalQuestions} questions`, { questionCount: totalQuestions });

    if (totalQuestions < 2) {
      logStageEvent("similarity", "info", "too_few_questions", `Only ${totalQuestions} questions, skipping similarity analysis`, { pipelineRunId });

      // Initialize all similarity_group_id to null and write output
      for (const q of questions) {
        q.similarity_group_id = null;
      }

      const emptyResult = {
        totalQuestions,
        groupsFound: 0,
        questionsAssigned: 0,
        outputPath,
      };

      await writeFile(outputPath, JSON.stringify(questions, null, 2), "utf-8");

      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          result: emptyResult,
        },
      });

      // Still enqueue next stage so pipeline completes
      const nextJobData: CategorySplitJobData = {
        tenantId,
        pipelineRunId,
        inputPath: outputPath,
        outputDir: path.join(path.dirname(outputPath), "split"),
      };
      await addJob(
        PipelineStage.CATEGORY_SPLIT,
        nextJobData as unknown as Record<string, unknown>,
      );
      await db.pipelineJob.create({
        data: {
          pipelineRunId,
          stage: PipelineStage.CATEGORY_SPLIT,
          status: "PENDING",
        },
      });
      await db.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { currentStage: PipelineStage.CATEGORY_SPLIT },
      });

      return emptyResult;
    }

    // Run Python script for similarity detection
    await job.updateProgress(10);
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
      data: { progress: 10 },
    });

    await runPythonSimilarity(inputPath, outputPath, crossEncoderThreshold, refineThreshold);

    await job.updateProgress(90);
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
      data: { progress: 90 },
    });

    // Read the output to count results
    const outputRaw = await readFile(outputPath, "utf-8");
    const outputQuestions: CategorizedQuestionEntry[] = JSON.parse(outputRaw);

    const groups = new Set<string>();
    let assigned = 0;
    for (const q of outputQuestions) {
      if (q.similarity_group_id) {
        groups.add(q.similarity_group_id);
        assigned++;
      }
    }

    trackSimilarityGroups(groups.size);

    const result = {
      totalQuestions,
      groupsFound: groups.size,
      questionsAssigned: assigned,
      outputPath,
    };

    await job.updateProgress(100);

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result,
      },
    });

    // Enqueue next stage: category-split
    const nextJobData: CategorySplitJobData = {
      tenantId,
      pipelineRunId,
      inputPath: outputPath,
      outputDir: path.join(path.dirname(outputPath), "split"),
    };
    await addJob(
      PipelineStage.CATEGORY_SPLIT,
      nextJobData as unknown as Record<string, unknown>,
    );

    // Create pipeline job record for next stage
    await db.pipelineJob.create({
      data: {
        pipelineRunId,
        stage: PipelineStage.CATEGORY_SPLIT,
        status: "PENDING",
      },
    });

    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { currentStage: PipelineStage.CATEGORY_SPLIT },
    });

    logStageEvent("similarity", "info", "job_completed", `${groups.size} groups, ${assigned}/${totalQuestions} questions assigned`, { pipelineRunId, groupCount: groups.size, assignedCount: assigned });
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("similarity", "error", "job_failed", errorMsg, { pipelineRunId });

    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.SIMILARITY },
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
export function createSimilarityWorker(): Worker<SimilarityJobData> {
  const config = getConfig();
  const worker = createWorker<SimilarityJobData>(
    PipelineStage.SIMILARITY,
    processSimilarity,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[similarity] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[similarity] Job ${job?.id} failed:`, err.message);
  });

  console.log("[similarity] Worker registered");
  return worker;
}
