import { describe, it, expect } from "vitest";
import {
  PipelineStage,
  PIPELINE_STAGES_ORDERED,
  JobStatus,
  QuestionType,
  ParsedQuestionSchema,
  CategorySchema,
  CategorizationSchema,
  FullQuestionSchema,
} from "./index.js";

describe("PipelineStage", () => {
  it("defines all pipeline stages", () => {
    expect(PipelineStage.PDF_EXTRACT).toBe("pdf-extract");
    expect(PipelineStage.GEMINI_PARSE).toBe("gemini-parse");
    expect(PipelineStage.CATEGORIZE).toBe("categorize");
    expect(PipelineStage.MANUAL_SIMILARITY_UPLOAD).toBe("manual-similarity-upload");
    expect(PipelineStage.BATCH_COORDINATE).toBe("batch-coordinate");
    expect(PipelineStage.SIMILARITY).toBe("similarity");
    expect(PipelineStage.CATEGORY_SPLIT).toBe("category-split");
  });

  it("has ordered stages in correct sequence", () => {
    expect(PIPELINE_STAGES_ORDERED).toEqual([
      "pdf-extract",
      "gemini-parse",
      "categorize",
      "manual-similarity-upload",
      "similarity",
      "category-split",
    ]);
  });
});

describe("JobStatus", () => {
  it("defines all job statuses", () => {
    expect(JobStatus.PENDING).toBe("pending");
    expect(JobStatus.ACTIVE).toBe("active");
    expect(JobStatus.COMPLETED).toBe("completed");
    expect(JobStatus.FAILED).toBe("failed");
    expect(JobStatus.RETRYING).toBe("retrying");
  });
});

describe("QuestionType", () => {
  it("defines all question types", () => {
    expect(QuestionType.MULTIPLE_CHOICE).toBe("multiple_choice");
    expect(QuestionType.FILL_IN).toBe("fill_in");
    expect(QuestionType.MATCHING).toBe("matching");
    expect(QuestionType.OPEN).toBe("open");
  });
});

describe("ParsedQuestionSchema", () => {
  it("validates a correct parsed question", () => {
    const valid = {
      question_number: "1",
      points: 2,
      question_text: "What is the capital?",
      question_type: "multiple_choice" as const,
      correct_answer: "A",
      options: ["A) Paris", "B) London"],
    };
    expect(ParsedQuestionSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid question type", () => {
    const invalid = {
      question_number: "1",
      points: 2,
      question_text: "Q",
      question_type: "essay",
      correct_answer: "A",
      options: [],
    };
    expect(() => ParsedQuestionSchema.parse(invalid)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => ParsedQuestionSchema.parse({})).toThrow();
  });
});

describe("CategorySchema", () => {
  it("validates a category", () => {
    const cat = { key: "anatomy", name: "Anatomy", file: "anatomy.json" };
    expect(CategorySchema.parse(cat)).toEqual(cat);
  });
});

describe("CategorizationSchema", () => {
  it("validates a categorization result", () => {
    const result = { success: true, category: "anatomy", reasoning: "About bones" };
    expect(CategorizationSchema.parse(result)).toEqual(result);
  });
});

describe("FullQuestionSchema", () => {
  it("validates a full question with all pipeline data", () => {
    const full = {
      file: "exam_q001_2pt.png",
      success: true,
      data: {
        question_number: "1",
        points: 2,
        question_text: "What is the femur?",
        question_type: "multiple_choice" as const,
        correct_answer: "B",
        options: ["A) Arm", "B) Leg"],
      },
      source_folder: "exam_2024",
      categorization: { success: true, category: "skeleton", reasoning: "Bone" },
      similarity_group_id: null,
    };
    expect(FullQuestionSchema.parse(full)).toEqual(full);
  });
});
