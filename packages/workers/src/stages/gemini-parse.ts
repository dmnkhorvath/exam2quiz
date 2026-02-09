import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Consumer } from "kafkajs";

import { GoogleGenAI } from "@google/genai";

import {
  PipelineStage,
  type GeminiParseJobData,
  type CategorizeJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent, trackQuestionProcessed, trackGeminiCall } from "../metrics.js";

// ─── Constants ────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-3-flash-preview";
const MAX_RETRIES = 3;
const CONCURRENCY_LIMIT = 10; // parallel image calls to Gemini

const PARSE_SYSTEM_PROMPT = `Parse this Hungarian medical exam image. RED TEXT = correct answers filled in by solution key.

Extract these fields:
- question_number: e.g. "1.", "2.*", "19."
- points: integer from "X pont"
- question_text: ALL BLACK text. For tables, use markdown format with empty cells where red answers appear.
- question_type: "multiple_choice" or "fill_in" or "matching" or "open"
- correct_answer: RED text only. For tables, use markdown format showing the filled answers.
- options: list of all choices for multiple choice, empty [] otherwise

TABLE FORMATTING (use markdown):
- question_text table: show structure with EMPTY cells where red answers would go
- correct_answer table: show the RED answers in their positions

RULES:
- Tables MUST be markdown format in both question_text and correct_answer
- question_text: include all BLACK text, leave answer cells EMPTY
- correct_answer: show only RED text (answers), can be markdown table or plain text
- If no red text visible, set correct_answer to ""
- Keep Hungarian characters exact (á, é, í, ó, ö, ő, ú, ü, ű)`;

const PARSE_RESPONSE_SCHEMA = {
  type: "OBJECT" as const,
  properties: {
    question_number: { type: "STRING" as const },
    points: { type: "INTEGER" as const },
    question_text: { type: "STRING" as const },
    question_type: {
      type: "STRING" as const,
      enum: ["multiple_choice", "fill_in", "matching", "open"],
    },
    correct_answer: { type: "STRING" as const },
    options: { type: "ARRAY" as const, items: { type: "STRING" as const } },
  },
  required: [
    "question_number",
    "points",
    "question_text",
    "question_type",
    "correct_answer",
  ],
};

// ─── Result types ─────────────────────────────────────────────────
interface ParseResult {
  file: string;
  source_folder?: string;
  success: boolean;
  data?: {
    question_number: string;
    points: number;
    question_text: string;
    question_type: string;
    correct_answer: string;
    options?: string[];
  };
  error?: string;
  error_type?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 429) {
    return true;
  }
  return String(err).includes("429");
}

// ─── Get Gemini API key (tenant-specific or fallback) ─────────────
async function getGeminiApiKey(tenantId: string): Promise<string> {
  const db = getDb();
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { geminiApiKey: true },
  });

  if (tenant?.geminiApiKey) return tenant.geminiApiKey;

  const config = getConfig();
  if (config.GEMINI_API_KEY) return config.GEMINI_API_KEY;

  throw new Error(
    `No Gemini API key configured for tenant ${tenantId} or in environment`,
  );
}

// ─── Parse a single image with Gemini ─────────────────────────────
async function parseSingleImage(
  imagePath: string,
  apiKey: string,
): Promise<ParseResult> {
  const fileName = path.basename(imagePath);
  const ai = new GoogleGenAI({ apiKey });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const imageData = await readFile(imagePath);
      const base64Image = imageData.toString("base64");

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/png", data: base64Image } },
              { text: PARSE_SYSTEM_PROMPT },
            ],
          },
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: PARSE_RESPONSE_SCHEMA,
        },
      });

      const responseText = response.text ?? "";
      const parsed = JSON.parse(responseText);

      trackGeminiCall("gemini-parse", "success");
      trackQuestionProcessed("gemini-parse", true);
      return { file: fileName, success: true, data: parsed };
    } catch (err) {
      // Rate limit: exponential backoff
      if (isRateLimitError(err) && attempt < MAX_RETRIES - 1) {
        trackGeminiCall("gemini-parse", "rate_limited");
        logStageEvent("gemini-parse", "warn", "rate_limited", `Rate limited on ${fileName}, retrying (attempt ${attempt + 1})`, { file: fileName });
        await sleep((attempt + 1) * 2000);
        continue;
      }

      // JSON parse error: simple retry
      if (err instanceof SyntaxError && attempt < MAX_RETRIES - 1) {
        logStageEvent("gemini-parse", "warn", "json_parse_retry", `JSON parse error on ${fileName}, retrying`, { file: fileName });
        await sleep(1000);
        continue;
      }

      // Other errors: simple retry
      if (attempt < MAX_RETRIES - 1) {
        logStageEvent("gemini-parse", "warn", "api_error_retry", `API error on ${fileName}, retrying`, { file: fileName, error: String(err) });
        await sleep(1000);
        continue;
      }

      // All retries exhausted
      trackGeminiCall("gemini-parse", "failure");
      trackQuestionProcessed("gemini-parse", false);
      const errorType = err instanceof SyntaxError
        ? "json_parse_error"
        : "api_error";
      logStageEvent("gemini-parse", "error", "parse_failed", `Failed to parse ${fileName} after ${MAX_RETRIES} attempts`, { file: fileName, errorType });
      return {
        file: fileName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        error_type: errorType,
      };
    }
  }

  return { file: fileName, success: false, error: "Max retries exceeded" };
}

// ─── Process images with concurrency limit ────────────────────────
async function processImagesWithConcurrency(
  imagePaths: string[],
  apiKey: string,
  concurrency: number,
  onProgress: (completed: number, total: number) => void,
): Promise<ParseResult[]> {
  const results: ParseResult[] = new Array(imagePaths.length);
  let completed = 0;

  // Process in batches of `concurrency` size
  for (let i = 0; i < imagePaths.length; i += concurrency) {
    const batch = imagePaths.slice(i, i + concurrency);
    const batchPromises = batch.map((imgPath, batchIdx) =>
      parseSingleImage(imgPath, apiKey).then((result) => {
        results[i + batchIdx] = result;
        completed++;
        onProgress(completed, imagePaths.length);
        return result;
      }),
    );
    await Promise.all(batchPromises);
  }

  return results;
}

// ─── Kafka Processor ─────────────────────────────────────────────
async function processGeminiParse(
  job: { data: GeminiParseJobData },
): Promise<{ totalQuestions: number; successfulQuestions: number; parsedPath: string }> {
  const { tenantId, pipelineRunId, imagePaths, outputDir } = job.data;
  const db = getDb();

  logStageEvent("gemini-parse", "info", "job_started", `Processing ${imagePaths.length} images`, { tenantId, pipelineRunId, imageCount: imagePaths.length });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.GEMINI_PARSE },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    const apiKey = await getGeminiApiKey(tenantId);

    const results = await processImagesWithConcurrency(
      imagePaths,
      apiKey,
      CONCURRENCY_LIMIT,
      async (completed, total) => {
        const progress = Math.round((completed / total) * 100);
        // job.updateProgress(progress);
        await db.pipelineJob.updateMany({
          where: { pipelineRunId, stage: PipelineStage.GEMINI_PARSE },
          data: { progress },
        });
      },
    );

    // Add source_folder to each result (derived from image's parent directory name)
    for (const result of results) {
      const imgPath = imagePaths.find((p) => path.basename(p) === result.file);
      if (imgPath) {
        result.source_folder = path.basename(path.dirname(imgPath));
      }
    }

    // Save merged parsed.json at run-level outputDir (not inside a PDF subfolder)
    // so all questions from all PDFs are in one file for downstream stages
    const parsedPath = path.join(outputDir, "parsed.json");

    await writeFile(parsedPath, JSON.stringify(results, null, 2), "utf-8");

    const successfulCount = results.filter((r) => r.success).length;

    // job.updateProgress(100);

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.GEMINI_PARSE },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result: {
          totalQuestions: results.length,
          successfulQuestions: successfulCount,
          parsedPath,
        },
      },
    });

    // Enqueue next stage: categorize
    const nextJobData: CategorizeJobData = {
      tenantId,
      pipelineRunId,
      parsedQuestionsPath: parsedPath,
      outputPath: path.join(outputDir, "categorized.json"),
    };
    await addJob(
      PipelineStage.CATEGORIZE,
      nextJobData as unknown as Record<string, unknown>,
    );

    // Create pipeline job record for next stage
    await db.pipelineJob.create({
      data: {
        pipelineRunId,
        stage: PipelineStage.CATEGORIZE,
        status: "PENDING",
      },
    });

    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { currentStage: PipelineStage.CATEGORIZE },
    });

    const failedCount = results.length - successfulCount;
    logStageEvent("gemini-parse", "info", "job_completed", `Parsed ${successfulCount}/${results.length} questions`, { pipelineRunId, successfulCount, failedCount });
    if (failedCount > 0) {
      logStageEvent("gemini-parse", "warn", "partial_failure", `${failedCount} questions failed to parse`, { pipelineRunId, failedCount });
    }
    return {
      totalQuestions: results.length,
      successfulQuestions: successfulCount,
      parsedPath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("gemini-parse", "error", "job_failed", errorMsg, { pipelineRunId });

    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.GEMINI_PARSE },
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
export async function createGeminiParseWorker(): Promise<Consumer> {
  const config = getConfig();
  const worker = await createWorker(
    PipelineStage.GEMINI_PARSE,
    processGeminiParse,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  console.log("[gemini-parse] Worker registered");
  return worker;
}
