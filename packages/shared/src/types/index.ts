import { z } from "zod";

// ─── Pipeline Stage Enum ───────────────────────────────────────────
export const PipelineStage = {
  PDF_EXTRACT: "pdf-extract",
  GEMINI_PARSE: "gemini-parse",
  CATEGORIZE: "categorize",
  BATCH_COORDINATE: "batch-coordinate",
  MANUAL_SIMILARITY_UPLOAD: "manual-similarity-upload",
  SIMILARITY: "similarity",
  CATEGORY_SPLIT: "category-split",
} as const;

export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

export const PIPELINE_STAGES_ORDERED: PipelineStage[] = [
  PipelineStage.PDF_EXTRACT,
  PipelineStage.GEMINI_PARSE,
  PipelineStage.CATEGORIZE,
  PipelineStage.MANUAL_SIMILARITY_UPLOAD,
  PipelineStage.SIMILARITY,
  PipelineStage.CATEGORY_SPLIT,
];

// ─── Job Status ────────────────────────────────────────────────────
export const JobStatus = {
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRYING: "retrying",
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

// ─── Question Types ────────────────────────────────────────────────
export const QuestionType = {
  MULTIPLE_CHOICE: "multiple_choice",
  FILL_IN: "fill_in",
  MATCHING: "matching",
  OPEN: "open",
} as const;

export type QuestionType = (typeof QuestionType)[keyof typeof QuestionType];

// ─── Parsed Question ───────────────────────────────────────────────
export const ParsedQuestionSchema = z.object({
  question_number: z.string(),
  points: z.number(),
  question_text: z.string(),
  question_type: z.nativeEnum(QuestionType),
  correct_answer: z.string(),
  options: z.array(z.string()),
});

export type ParsedQuestion = z.infer<typeof ParsedQuestionSchema>;

// ─── Category Definition ───────────────────────────────────────────
export const CategorySchema = z.object({
  key: z.string(),
  name: z.string(),
  subcategory: z.string().optional(),
  file: z.string(),
});

export type Category = z.infer<typeof CategorySchema>;

// ─── Categorization Result ─────────────────────────────────────────
export const CategorizationSchema = z.object({
  success: z.boolean(),
  category: z.string(),
  subcategory: z.string().optional(),
  reasoning: z.string(),
});

export type Categorization = z.infer<typeof CategorizationSchema>;

// ─── Full Question (after all pipeline stages) ─────────────────────
export const FullQuestionSchema = z.object({
  file: z.string(),
  success: z.boolean(),
  data: ParsedQuestionSchema,
  source_folder: z.string(),
  categorization: CategorizationSchema,
  similarity_group_id: z.string().nullable(),
});

export type FullQuestion = z.infer<typeof FullQuestionSchema>;

// ─── Queue Job Payloads ────────────────────────────────────────────
export interface PdfExtractJobData {
  tenantId: string;
  pipelineRunId: string;
  pdfPaths: string[];
  outputDir: string;
  dpi?: number;
}

export interface GeminiParseJobData {
  tenantId: string;
  pipelineRunId: string;
  imagePaths: string[];
  outputDir: string;
}

export interface CategorizeJobData {
  tenantId: string;
  pipelineRunId: string;
  parsedQuestionsPath: string;
  outputPath: string;
}

export interface SimilarityJobData {
  tenantId: string;
  pipelineRunId: string;
  inputPath: string;
  outputPath: string;
  crossEncoderThreshold?: number;
  refineThreshold?: number;
}

export interface CategorySplitJobData {
  tenantId: string;
  pipelineRunId: string;
  inputPath: string;
  outputDir: string;
}

export interface BatchCoordinatorJobData {
  tenantId: string;
  parentPipelineRunId: string;
  childPipelineRunIds: string[];
}

export type PipelineJobData =
  | PdfExtractJobData
  | GeminiParseJobData
  | CategorizeJobData
  | SimilarityJobData
  | CategorySplitJobData
  | BatchCoordinatorJobData;

// ─── Batch Processing Defaults ────────────────────────────────────
export const BATCH_DEFAULTS = {
  BATCH_SIZE: 30,
  MAX_BATCHES: 20,
  COORDINATOR_POLL_INTERVAL: 10_000,
  COORDINATOR_TIMEOUT: 4 * 60 * 60 * 1000,
} as const;

// ─── API Types ─────────────────────────────────────────────────────
export interface TenantConfig {
  id: string;
  name: string;
  slug: string;
  geminiApiKey?: string;
  categoriesConfig?: Category[];
  maxConcurrentPipelines: number;
  isActive: boolean;
}

export interface PipelineRunSummary {
  id: string;
  tenantId: string;
  status: string;
  currentStage: PipelineStage | null;
  totalPdfs: number;
  processedPdfs: number;
  totalQuestions: number;
  createdAt: Date;
  updatedAt: Date;
}
