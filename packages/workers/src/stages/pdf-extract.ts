import { type Job, type Worker } from "bullmq";
import * as mupdf from "mupdf";
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PipelineStage, type PdfExtractJobData, type GeminiParseJobData } from "@exams2quiz/shared/types";
import { getConfig } from "@exams2quiz/shared/config";
import { createWorker, addJob } from "@exams2quiz/shared/queue";
import { getDb } from "@exams2quiz/shared/db";

// ─── Constants ────────────────────────────────────────────────────
// "X pont" pattern — Hungarian for "X points", used as question delimiters
const QUESTION_PATTERN = /(?<!\d[-–])\b(\d+)\s*pont\b(?!\s*adható)/i;
const SKIP_WORDS = ["adható", "válaszonként", "helyes válasz", "pontonként"];

interface QuestionPosition {
  points: number;
  yTop: number;
  lineText: string;
}

interface ExtractedQuestion {
  question_number: string;
  global_index: number;
  page: number;
  image_file: string;
  preview: string;
}

// ─── Find question positions on a page ────────────────────────────
function findQuestionPositions(page: mupdf.Page, pageWidth: number): QuestionPosition[] {
  const questions: QuestionPosition[] = [];

  // Use page.search() which returns Quad[][] — each match is an array of quads
  const matches = page.search("pont");

  for (const quads of matches) {
    if (quads.length === 0) continue;

    // Quad = [ul_x, ul_y, ur_x, ur_y, ll_x, ll_y, lr_x, lr_y]
    const quad = quads[0];
    const x0 = quad[0]; // upper-left x
    const y0 = quad[1]; // upper-left y

    // Skip matches in the left half of the page (question markers are on the right)
    if (x0 < pageWidth * 0.5) continue;

    // Get surrounding text context using structured text walker
    const areaText = getTextNearPoint(page, x0, y0, 100, 150);

    // Skip scoring instruction lines
    if (SKIP_WORDS.some((w) => areaText.toLowerCase().includes(w))) continue;

    const match = QUESTION_PATTERN.exec(areaText);
    if (match) {
      questions.push({
        points: parseInt(match[1], 10),
        yTop: y0,
        lineText: areaText.slice(0, 80),
      });
    }
  }

  // Sort by vertical position
  questions.sort((a, b) => a.yTop - b.yTop);

  // De-duplicate closely spaced matches (within 10pt)
  const filtered: QuestionPosition[] = [];
  let lastY = -100;
  for (const q of questions) {
    if (Math.abs(q.yTop - lastY) > 10) {
      filtered.push(q);
      lastY = q.yTop;
    }
  }

  return filtered;
}

// ─── Get text near a point using structured text walker ───────────
function getTextNearPoint(page: mupdf.Page, x: number, y: number, leftExpand: number, rightExpand: number): string {
  const sText = page.toStructuredText("preserve-whitespace");
  const chars: { c: string; ox: number; oy: number }[] = [];

  sText.walk({
    onChar(c, origin, _font, _size, _quad) {
      chars.push({ c, ox: origin[0], oy: origin[1] });
    },
  });

  // Collect characters within the bounding box around the target point
  const minX = x - leftExpand;
  const maxX = x + rightExpand;
  const minY = y - 10;
  const maxY = y + 15;

  let result = "";
  for (const ch of chars) {
    if (ch.ox >= minX && ch.ox <= maxX && ch.oy >= minY && ch.oy <= maxY) {
      result += ch.c;
    }
  }

  return result.trim();
}

// ─── Process a single PDF file ────────────────────────────────────
async function extractQuestionsFromPdf(
  pdfBuffer: Buffer,
  pdfName: string,
  outputDir: string,
  dpi: number,
): Promise<{ questions: ExtractedQuestion[]; error?: string }> {
  const pdfStem = path.basename(pdfName, path.extname(pdfName));
  const pdfOutputDir = path.join(outputDir, pdfStem);
  await mkdir(pdfOutputDir, { recursive: true });

  const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  const questions: ExtractedQuestion[] = [];
  let questionCounter = 0;

  try {
    const pageCount = doc.countPages();

    for (let pageNum = 0; pageNum < pageCount; pageNum++) {
      const page = doc.loadPage(pageNum);
      const bounds = page.getBounds(); // Rect = [x0, y0, x1, y1]
      const pageWidth = bounds[2] - bounds[0];
      const pageHeight = bounds[3] - bounds[1];

      const positions = findQuestionPositions(page, pageWidth);
      if (positions.length === 0) continue;

      // Render full page at target DPI
      const zoom = dpi / 72;
      const matrix = mupdf.Matrix.scale(zoom, zoom);
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
      const fullPng = pixmap.asPNG();
      const fullHeight = pixmap.getHeight();
      const fullWidth = pixmap.getWidth();

      const padding = 10;

      for (let i = 0; i < positions.length; i++) {
        questionCounter++;
        const q = positions[i];
        const yTop = q.yTop - padding;
        const yBottom = i + 1 < positions.length
          ? positions[i + 1].yTop - padding
          : pageHeight;

        // Calculate crop coordinates in pixel space
        const pxTop = Math.max(0, Math.floor(yTop * zoom));
        const pxBottom = Math.min(fullHeight, Math.ceil(yBottom * zoom));

        if (pxTop >= pxBottom || pxBottom <= 0 || pxTop >= fullHeight) continue;

        const cropHeight = pxBottom - pxTop;

        try {
          // Use sharp to crop the region from the full page PNG
          const croppedPng = await sharp(Buffer.from(fullPng))
            .extract({ left: 0, top: pxTop, width: fullWidth, height: cropHeight })
            .png()
            .toBuffer();

          const outputFilename = `${pdfStem}_q${String(questionCounter).padStart(3, "0")}_${q.points}pt.png`;
          const outputPath = path.join(pdfOutputDir, outputFilename);

          await writeFile(outputPath, croppedPng);

          questions.push({
            question_number: `${q.points}pt`,
            global_index: questionCounter,
            page: pageNum + 1,
            image_file: outputFilename,
            preview: q.lineText,
          });
        } catch (err) {
          console.error(`[pdf-extract] Failed to render question ${questionCounter} on page ${pageNum + 1}:`, err);
        }
      }
    }

    // Write manifest
    const manifest = {
      file: pdfName,
      output_dir: pdfOutputDir,
      question_count: questions.length,
      questions,
    };
    await writeFile(path.join(pdfOutputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    return { questions };
  } finally {
    doc.destroy();
  }
}

// ─── BullMQ Processor ─────────────────────────────────────────────
async function processPdfExtract(job: Job<PdfExtractJobData>): Promise<{ questionCount: number; imagePaths: string[] }> {
  const { tenantId, pipelineRunId, pdfPath, outputDir, dpi = 150 } = job.data;
  const db = getDb();

  console.log(`[pdf-extract] Processing: ${path.basename(pdfPath)} (tenant: ${tenantId})`);

  // Update job status to active
  await db.pipelineJob.updateMany({
    where: { pipelineRunId, stage: PipelineStage.PDF_EXTRACT },
    data: { status: "ACTIVE", startedAt: new Date() },
  });

  try {
    // Read the PDF file
    const pdfBuffer = await readFile(pdfPath);
    const result = await extractQuestionsFromPdf(pdfBuffer, path.basename(pdfPath), outputDir, dpi);

    await job.updateProgress(100);

    // Collect image paths for next stage
    const pdfStem = path.basename(pdfPath, path.extname(pdfPath));
    const pdfOutputDir = path.join(outputDir, pdfStem);
    const imagePaths = result.questions.map((q) => path.join(pdfOutputDir, q.image_file));

    // Update job status to completed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.PDF_EXTRACT },
      data: {
        status: "COMPLETED",
        progress: 100,
        completedAt: new Date(),
        result: { questionCount: result.questions.length, imagePaths },
      },
    });

    // Update pipeline run progress
    await db.pipelineRun.update({
      where: { id: pipelineRunId },
      data: {
        processedPdfs: { increment: 1 },
        totalQuestions: { increment: result.questions.length },
      },
    });

    // Enqueue next stage: gemini-parse
    if (imagePaths.length > 0) {
      const nextJobData: GeminiParseJobData = {
        tenantId,
        pipelineRunId,
        imagePaths,
        outputDir,
      };
      await addJob(PipelineStage.GEMINI_PARSE, nextJobData as unknown as Record<string, unknown>);

      // Create pipeline job record for next stage
      await db.pipelineJob.create({
        data: {
          pipelineRunId,
          stage: PipelineStage.GEMINI_PARSE,
          status: "PENDING",
        },
      });

      await db.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { currentStage: PipelineStage.GEMINI_PARSE },
      });
    }

    console.log(`[pdf-extract] Done: ${result.questions.length} questions from ${path.basename(pdfPath)}`);
    return { questionCount: result.questions.length, imagePaths };
  } catch (err) {
    // Update job status to failed
    await db.pipelineJob.updateMany({
      where: { pipelineRunId, stage: PipelineStage.PDF_EXTRACT },
      data: {
        status: "FAILED",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });

    throw err;
  }
}

// ─── Worker Registration ──────────────────────────────────────────
export function createPdfExtractWorker(): Worker<PdfExtractJobData> {
  const config = getConfig();
  const worker = createWorker<PdfExtractJobData>(
    PipelineStage.PDF_EXTRACT,
    processPdfExtract,
    { concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[pdf-extract] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[pdf-extract] Job ${job?.id} failed:`, err.message);
  });

  console.log("[pdf-extract] Worker registered");
  return worker;
}
