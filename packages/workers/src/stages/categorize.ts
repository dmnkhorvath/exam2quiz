import { type Job, type Worker } from "bullmq";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  SchemaType,
} from "@google/generative-ai";

import { Prisma } from "@prisma/client";

import {
  PipelineStage,
  type CategorizeJobData,
  type SimilarityJobData,
  type Category,
} from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";
import { logStageEvent, trackQuestionProcessed, trackGeminiCall, trackCategoryQuestion } from "../metrics.js";

// ─── Constants ────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-3-flash-preview";
const MAX_RETRIES = 3;
const CONCURRENCY_LIMIT = 10;
const UPSERT_CHUNK_SIZE = 100;
const TRANSACTION_TIMEOUT = 60_000; // 60s for large batches

// Category guidelines are now derived dynamically from tenant DB categories

// ─── Result types ─────────────────────────────────────────────────
interface ParsedQuestionEntry {
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
  error?: string;
}

interface CategorizedQuestionEntry extends ParsedQuestionEntry {
  categorization: {
    success: boolean;
    category?: string;
    subcategory?: string;
    reasoning?: string;
    error?: string;
  };
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

// ─── Build system prompt from categories ──────────────────────────
function buildSystemPrompt(categories: Category[]): string {
  const hasSubcategories = categories.some((c) => c.subcategory);

  if (hasSubcategories) {
    // Group categories by name, list subcategories under each
    const grouped = new Map<string, string[]>();
    for (const c of categories) {
      const subs = grouped.get(c.name) ?? [];
      if (c.subcategory) subs.push(c.subcategory);
      grouped.set(c.name, subs);
    }

    const categoryList = [...grouped.entries()]
      .map(([name, subs], i) => {
        const subList = subs.map((s) => `   - ${s}`).join("\n");
        return `${i + 1}. ${name}\n${subList}`;
      })
      .join("\n");

    return `You are a medical exam question categorizer. Your task is to categorize Hungarian medical exam questions into a category and subcategory from the following list:

${categoryList}

Rules:
- Choose the SINGLE most appropriate category AND subcategory based on the question content
- Return the category name AND subcategory name exactly as written above
- If a question spans multiple topics, choose the PRIMARY topic
- Consider both the question text and the correct answer when categorizing`;
  }

  const categoryList = categories
    .map((c, i) => `${i + 1}. ${c.name}`)
    .join("\n");

  return `You are a medical exam question categorizer. Your task is to categorize Hungarian medical exam questions into exactly one of these categories:

${categoryList}

Rules:
- Choose the SINGLE most appropriate category based on the question content
- Return ONLY the category name exactly as written above
- If a question spans multiple topics, choose the PRIMARY topic
- Consider both the question text and the correct answer when categorizing`;
}

// ─── Build response schema from categories ────────────────────────
function buildResponseSchema(categories: Category[]) {
  const hasSubcategories = categories.some((c) => c.subcategory);
  const uniqueNames = [...new Set(categories.map((c) => c.name))];

  const properties: Record<string, { type: SchemaType; enum?: string[]; description?: string }> = {
    category: {
      type: SchemaType.STRING,
      enum: uniqueNames as string[],
    },
    reasoning: {
      type: SchemaType.STRING,
      description: "Brief explanation for the categorization",
    },
  };

  const required = ["category", "reasoning"];

  if (hasSubcategories) {
    const uniqueSubcategories = [...new Set(
      categories.filter((c) => c.subcategory).map((c) => c.subcategory as string),
    )];
    properties.subcategory = {
      type: SchemaType.STRING,
      enum: uniqueSubcategories as string[],
    };
    required.push("subcategory");
  }

  return {
    type: SchemaType.OBJECT,
    properties,
    required,
  };
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

// ─── Categorize a single question with Gemini ─────────────────────
async function categorizeSingleQuestion(
  question: ParsedQuestionEntry,
  apiKey: string,
  categories: Category[],
  systemPrompt: string,
): Promise<CategorizedQuestionEntry> {
  const data = question.data;
  if (!data) {
    return {
      ...question,
      categorization: { success: false, error: "No parsed data available" },
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema(categories),
    },
  });

  const prompt = `Categorize this Hungarian medical exam question:

Question: ${data.question_text}

Correct Answer: ${data.correct_answer}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      const parsed = JSON.parse(responseText);

      // Validate category is in the allowed list
      const categoryNames = [...new Set(categories.map((c) => c.name))];
      let category = parsed.category as string | undefined;
      if (!category) {
        logStageEvent("categorize", "warn", "missing_category", "Gemini returned no category field", { file: question.file });
        trackGeminiCall("categorize", "failure");
        trackQuestionProcessed("categorize", false);
        return {
          ...question,
          categorization: { success: false, category: "", reasoning: "No category in response" },
        };
      }
      if (!categoryNames.includes(category)) {
        // Try closest match
        const match = categoryNames.find(
          (name) =>
            name.toLowerCase().includes(category!.toLowerCase()) ||
            category!.toLowerCase().includes(name.toLowerCase()),
        );
        if (match) category = match;
      }

      // Validate subcategory if present
      const hasSubcategories = categories.some((c) => c.subcategory);
      let subcategory = parsed.subcategory as string | undefined;
      if (hasSubcategories && subcategory) {
        const validSubcategories = categories
          .filter((c) => c.name === category && c.subcategory)
          .map((c) => c.subcategory as string);
        if (!validSubcategories.includes(subcategory)) {
          const match = validSubcategories.find(
            (s) =>
              s.toLowerCase().includes(subcategory!.toLowerCase()) ||
              subcategory!.toLowerCase().includes(s.toLowerCase()),
          );
          if (match) subcategory = match;
        }
      }

      trackGeminiCall("categorize", "success");
      trackQuestionProcessed("categorize", true);
      trackCategoryQuestion(category);
      return {
        ...question,
        categorization: {
          success: true,
          category,
          ...(subcategory ? { subcategory } : {}),
          reasoning: parsed.reasoning ?? "",
        },
      };
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES - 1) {
        trackGeminiCall("categorize", "rate_limited");
        logStageEvent("categorize", "warn", "rate_limited", `Rate limited on ${question.file}, retrying`, { file: question.file });
        await sleep((attempt + 1) * 2000);
        continue;
      }

      if (err instanceof SyntaxError && attempt < MAX_RETRIES - 1) {
        logStageEvent("categorize", "warn", "json_parse_retry", `JSON parse error on ${question.file}, retrying`, { file: question.file });
        await sleep(1000);
        continue;
      }

      if (attempt < MAX_RETRIES - 1) {
        logStageEvent("categorize", "warn", "api_error_retry", `API error on ${question.file}, retrying`, { file: question.file, error: String(err) });
        await sleep(1000);
        continue;
      }

      trackGeminiCall("categorize", "failure");
      trackQuestionProcessed("categorize", false);
      logStageEvent("categorize", "error", "categorize_failed", `Failed to categorize ${question.file} after ${MAX_RETRIES} attempts`, { file: question.file });
      return {
        ...question,
        categorization: {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    ...question,
    categorization: { success: false, error: "Max retries exceeded" },
  };
}

// ─── Process questions with concurrency limit ─────────────────────
async function categorizeWithConcurrency(
  questions: ParsedQuestionEntry[],
  apiKey: string,
  categories: Category[],
  systemPrompt: string,
  concurrency: number,
  onProgress: (completed: number, total: number) => void,
): Promise<CategorizedQuestionEntry[]> {
  const results: CategorizedQuestionEntry[] = new Array(questions.length);
  let completed = 0;

  for (let i = 0; i < questions.length; i += concurrency) {
    const batch = questions.slice(i, i + concurrency);
    const batchPromises = batch.map((q, batchIdx) =>
      categorizeSingleQuestion(q, apiKey, categories, systemPrompt).then(
        (result) => {
          results[i + batchIdx] = result;
          completed++;
          onProgress(completed, questions.length);
          return result;
        },
      ),
    );
    await Promise.all(batchPromises);
  }

  return results;
}

// ─── Enqueue next stage or complete child run ─────────────────────
async function enqueueNextStageOrComplete(
  tenantId: string,
  pipelineRunId: string,
  mergedPath: string,
  outputPath: string,
): Promise<void> {
  const db = getDb();

  // Check if this is a child run in a batch
  const run = await db.pipelineRun.findUniqueOrThrow({
    where: { id: pipelineRunId },
    select: { parentRunId: true },
  });

  if (run.parentRunId) {
    // Child batch run — do NOT enqueue similarity.
    // Mark this child as COMPLETED; the batch coordinator handles similarity.
    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    logStageEvent("categorize", "info", "child_run_completed", "Batch child run completed at categorize stage — skipping similarity", { tenantId, pipelineRunId, parentRunId: run.parentRunId });
    return;
  }

  // Standalone run — enqueue similarity on the full tenant question set
  const nextJobData: SimilarityJobData = {
    tenantId,
    pipelineRunId,
    inputPath: mergedPath,
    outputPath: path.join(path.dirname(outputPath), "similarity.json"),
  };
  await addJob(
    PipelineStage.SIMILARITY,
    nextJobData as unknown as Record<string, unknown>,
  );
  await db.pipelineJob.create({
    data: {
      pipelineRunId,
      stage: PipelineStage.SIMILARITY,
      status: "PENDING",
    },
  });
  await db.pipelineRun.update({
    where: { id: pipelineRunId },
    data: { currentStage: PipelineStage.SIMILARITY },
  });
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processCategorize(
  job: Job<CategorizeJobData>,
): Promise<{
  totalQuestions: number;
  categorizedQuestions: number;
  categorizedPath: string;
}> {
  const { tenantId, pipelineRunId, parsedQuestionsPath, outputPath } =
    job.data;
  const db = getDb();

  logStageEvent("categorize", "info", "job_started", `Processing questions from ${parsedQuestionsPath}`, { tenantId, pipelineRunId });

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    // Load tenant-specific categories from DB
    const tenantCategories = await db.tenantCategory.findMany({
      where: { tenantId },
      orderBy: { sortOrder: "asc" },
    });
    const categories: Category[] = tenantCategories.map((tc) => ({
      key: tc.key,
      name: tc.name,
      subcategory: tc.subcategory ?? undefined,
      file: tc.file,
    }));

    // Load parsed questions
    const parsedRaw = await readFile(parsedQuestionsPath, "utf-8");
    const allQuestions: ParsedQuestionEntry[] = JSON.parse(parsedRaw);

    // If tenant has no categories, skip categorization entirely
    if (categories.length === 0) {
      logStageEvent("categorize", "info", "no_tenant_categories", "Tenant has no categories, skipping categorization", { tenantId, pipelineRunId });

      // Pass questions through with empty categorization
      const passthrough: CategorizedQuestionEntry[] = allQuestions.map((q) => ({
        ...q,
        categorization: { success: false, error: "No categories configured for tenant" },
      }));

      await writeFile(outputPath, JSON.stringify(passthrough, null, 2), "utf-8");

      // Upsert questions + load all tenant questions atomically
      const allTenantQs = await db.$transaction(async (tx) => {
        for (let i = 0; i < passthrough.length; i += UPSERT_CHUNK_SIZE) {
          const chunk = passthrough.slice(i, i + UPSERT_CHUNK_SIZE);
          await Promise.all(chunk.map((q) =>
            tx.question.upsert({
              where: { tenantId_file: { tenantId, file: q.file } },
              create: {
                tenantId,
                pipelineRunId,
                file: q.file,
                sourcePdf: q.source_folder ?? null,
                success: q.success,
                data: q.data ?? undefined,
                categorization: q.categorization,
                similarityGroupId: null,
              },
              update: {
                pipelineRunId,
                sourcePdf: q.source_folder ?? null,
                success: q.success,
                data: q.data ?? undefined,
                categorization: q.categorization,
                similarityGroupId: null,
              },
            }),
          ));
        }

        return tx.question.findMany({ where: { tenantId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TRANSACTION_TIMEOUT });
      const mergedCat: CategorizedQuestionEntry[] = allTenantQs.map((q) => ({
        file: q.file, success: q.success, source_folder: q.sourcePdf ?? undefined,
        data: q.data as CategorizedQuestionEntry["data"],
        categorization: q.categorization as CategorizedQuestionEntry["categorization"],
      }));
      const mergedPath = path.join(path.dirname(outputPath), "categorized_merged.json");
      await writeFile(mergedPath, JSON.stringify(mergedCat, null, 2), "utf-8");

      const skipResult = {
        totalQuestions: allQuestions.length,
        categorizedQuestions: 0,
        categorizedPath: outputPath,
        mergedQuestions: allTenantQs.length,
      };

      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          result: skipResult,
        },
      });

      // Enqueue similarity or complete child run
      await enqueueNextStageOrComplete(tenantId, pipelineRunId, mergedPath, outputPath);

      return skipResult;
    }

    // Filter to only successful parses with data
    const validQuestions = allQuestions.filter((q) => q.success && q.data);

    logStageEvent("categorize", "info", "questions_loaded", `${validQuestions.length}/${allQuestions.length} valid questions to categorize`, { validCount: validQuestions.length, totalCount: allQuestions.length });
    if (validQuestions.length < allQuestions.length) {
      logStageEvent("categorize", "warn", "skipped_questions", `${allQuestions.length - validQuestions.length} questions skipped (no parsed data)`, { skippedCount: allQuestions.length - validQuestions.length });
    }

    if (validQuestions.length === 0) {
      logStageEvent("categorize", "warn", "no_valid_questions", "No valid questions to categorize, passing empty result to next stage", { pipelineRunId });

      await writeFile(outputPath, JSON.stringify([], null, 2), "utf-8");

      // Load all existing tenant questions for similarity (even if no new ones)
      const allTenantQs = await db.question.findMany({ where: { tenantId } });
      const mergedCat: CategorizedQuestionEntry[] = allTenantQs.map((q) => ({
        file: q.file, success: q.success, source_folder: q.sourcePdf ?? undefined,
        data: q.data as CategorizedQuestionEntry["data"],
        categorization: q.categorization as CategorizedQuestionEntry["categorization"],
      }));
      const mergedPath = path.join(path.dirname(outputPath), "categorized_merged.json");
      await writeFile(mergedPath, JSON.stringify(mergedCat, null, 2), "utf-8");

      const emptyResult = {
        totalQuestions: 0,
        categorizedQuestions: 0,
        categorizedPath: outputPath,
        mergedQuestions: allTenantQs.length,
      };

      await db.pipelineJob.updateMany({
        where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          result: emptyResult,
        },
      });

      // Enqueue similarity or complete child run
      await enqueueNextStageOrComplete(tenantId, pipelineRunId, mergedPath, outputPath);

      return emptyResult;
    }

    const apiKey = await getGeminiApiKey(tenantId);
    const systemPrompt = buildSystemPrompt(categories);

    const results = await categorizeWithConcurrency(
      validQuestions,
      apiKey,
      categories,
      systemPrompt,
      CONCURRENCY_LIMIT,
      async (completed, total) => {
        const progress = Math.round((completed / total) * 100);
        await job.updateProgress(progress);
        await db.pipelineJob.updateMany({
          where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
          data: { progress },
        });
      },
    );

    // Save this run's categorized questions to file (for reference)
    await writeFile(outputPath, JSON.stringify(results, null, 2), "utf-8");

    const categorizedCount = results.filter(
      (r) => r.categorization.success,
    ).length;

    // ─── Upsert new questions + load all tenant questions atomically ──
    // Serializable isolation prevents concurrent same-tenant pipelines
    // from reading an inconsistent merged question set.
    logStageEvent("categorize", "info", "upserting_questions", `Upserting ${results.length} questions to DB`, { tenantId, pipelineRunId });
    const allTenantQuestions = await db.$transaction(async (tx) => {
      for (let i = 0; i < results.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = results.slice(i, i + UPSERT_CHUNK_SIZE);
        await Promise.all(chunk.map((q) =>
          tx.question.upsert({
            where: { tenantId_file: { tenantId, file: q.file } },
            create: {
              tenantId,
              pipelineRunId,
              file: q.file,
              sourcePdf: q.source_folder ?? null,
              success: q.success,
              data: q.data ?? undefined,
              categorization: q.categorization,
              similarityGroupId: null,
            },
            update: {
              pipelineRunId,
              sourcePdf: q.source_folder ?? null,
              success: q.success,
              data: q.data ?? undefined,
              categorization: q.categorization,
              similarityGroupId: null,
            },
          }),
        ));
      }

      return tx.question.findMany({ where: { tenantId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: TRANSACTION_TIMEOUT });
    logStageEvent("categorize", "info", "tenant_questions_merged", `Merged: ${allTenantQuestions.length} total tenant questions (${results.length} new/updated)`, { tenantId, totalQuestions: allTenantQuestions.length, newQuestions: results.length });

    // Write the full tenant question set as categorized.json for similarity
    const mergedCategorized: CategorizedQuestionEntry[] = allTenantQuestions.map((q) => ({
      file: q.file,
      success: q.success,
      source_folder: q.sourcePdf ?? undefined,
      data: q.data as CategorizedQuestionEntry["data"],
      categorization: q.categorization as CategorizedQuestionEntry["categorization"],
    }));
    const mergedOutputPath = path.join(path.dirname(outputPath), "categorized_merged.json");
    await writeFile(mergedOutputPath, JSON.stringify(mergedCategorized, null, 2), "utf-8");

    await job.updateProgress(100);

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result: {
          totalQuestions: results.length,
          categorizedQuestions: categorizedCount,
          categorizedPath: outputPath,
          mergedQuestions: allTenantQuestions.length,
        },
      },
    });

    // Enqueue similarity or complete child run
    await enqueueNextStageOrComplete(tenantId, pipelineRunId, mergedOutputPath, outputPath);

    const failedCount = results.length - categorizedCount;
    logStageEvent("categorize", "info", "job_completed", `Categorized ${categorizedCount}/${results.length} questions`, { pipelineRunId, categorizedCount, failedCount });
    if (failedCount > 0) {
      logStageEvent("categorize", "warn", "partial_failure", `${failedCount} questions failed to categorize`, { pipelineRunId, failedCount });
    }
    return {
      totalQuestions: results.length,
      categorizedQuestions: categorizedCount,
      categorizedPath: outputPath,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logStageEvent("categorize", "error", "job_failed", errorMsg, { pipelineRunId });

    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.CATEGORIZE },
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
export function createCategorizeWorker(): Worker<CategorizeJobData> {
  const config = getConfig();
  const worker = createWorker<CategorizeJobData>(
    PipelineStage.CATEGORIZE,
    processCategorize,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[categorize] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[categorize] Job ${job?.id} failed:`, err.message);
  });

  console.log("[categorize] Worker registered");
  return worker;
}
