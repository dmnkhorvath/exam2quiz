import { type Job, type Worker } from "bullmq";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  SchemaType,
} from "@google/generative-ai";

import {
  PipelineStage,
  type GeminiParseJobData,
  type CategorizeJobData,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";

// ─── Constants ────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash";
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
  type: SchemaType.OBJECT,
  properties: {
    question_number: { type: SchemaType.STRING },
    points: { type: SchemaType.INTEGER },
    question_text: { type: SchemaType.STRING },
    question_type: {
      type: SchemaType.STRING,
      enum: ["multiple_choice", "fill_in", "matching", "open"] as string[],
    },
    correct_answer: { type: SchemaType.STRING },
    options: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
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
  if (err instanceof GoogleGenerativeAIFetchError && err.status === 429) {
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
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: PARSE_RESPONSE_SCHEMA,
    },
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const imageData = await readFile(imagePath);
      const base64Image = imageData.toString("base64");

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: "image/png",
            data: base64Image,
          },
        },
        { text: PARSE_SYSTEM_PROMPT },
      ]);

      const responseText = result.response.text();
      const parsed = JSON.parse(responseText);

      return { file: fileName, success: true, data: parsed };
    } catch (err) {
      // Rate limit: exponential backoff
      if (isRateLimitError(err) && attempt < MAX_RETRIES - 1) {
        await sleep((attempt + 1) * 2000);
        continue;
      }

      // JSON parse error: simple retry
      if (err instanceof SyntaxError && attempt < MAX_RETRIES - 1) {
        await sleep(1000);
        continue;
      }

      // Other errors: simple retry
      if (attempt < MAX_RETRIES - 1) {
        await sleep(1000);
        continue;
      }

      // All retries exhausted
      const errorType = err instanceof SyntaxError
        ? "json_parse_error"
        : "api_error";
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

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processGeminiParse(
  job: Job<GeminiParseJobData>,
): Promise<{ totalQuestions: number; successfulQuestions: number; parsedPath: string }> {
  const { tenantId, pipelineRunId, imagePaths, outputDir } = job.data;
  const db = getDb();

  console.log(
    `[gemini-parse] Processing ${imagePaths.length} images (tenant: ${tenantId})`,
  );

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
        await job.updateProgress(progress);
        await db.pipelineJob.updateMany({
          where: { pipelineRunId, stage: PipelineStage.GEMINI_PARSE },
          data: { progress },
        });
      },
    );

    // Determine output path — save parsed.json next to the images
    // Images from pdf-extract are in outputDir/<pdfStem>/ subfolders
    // We write parsed.json to the same directory as the first image
    const firstImageDir = imagePaths.length > 0
      ? path.dirname(imagePaths[0])
      : outputDir;
    const parsedPath = path.join(firstImageDir, "parsed.json");

    await writeFile(parsedPath, JSON.stringify(results, null, 2), "utf-8");

    const successfulCount = results.filter((r) => r.success).length;

    await job.updateProgress(100);

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
      categoriesConfigPath: path.join(
        process.cwd(),
        "config",
        "categories.json",
      ),
      outputPath: path.join(firstImageDir, "categorized.json"),
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

    console.log(
      `[gemini-parse] Done: ${successfulCount}/${results.length} questions parsed`,
    );
    return {
      totalQuestions: results.length,
      successfulQuestions: successfulCount,
      parsedPath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

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
export function createGeminiParseWorker(): Worker<GeminiParseJobData> {
  const config = getConfig();
  const worker = createWorker<GeminiParseJobData>(
    PipelineStage.GEMINI_PARSE,
    processGeminiParse,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[gemini-parse] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[gemini-parse] Job ${job?.id} failed:`, err.message);
  });

  console.log("[gemini-parse] Worker registered");
  return worker;
}
