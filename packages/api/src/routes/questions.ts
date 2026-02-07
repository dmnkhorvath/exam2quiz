import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { getConfig } from "@exams2quiz/shared/config";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Gemini constants (mirrored from workers) ─────────────────────
const GEMINI_MODEL = "gemini-3-flash-preview";

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
    points: { type: SchemaType.NUMBER },
    question_text: { type: SchemaType.STRING },
    question_type: { type: SchemaType.STRING },
    correct_answer: { type: SchemaType.STRING },
    options: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["question_number", "points", "question_text", "question_type", "correct_answer", "options"],
};

// ─── Helpers ────────────────────────────────────────────────────────

async function getGeminiApiKey(tenantId: string): Promise<string> {
  const db = getDb();
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { geminiApiKey: true },
  });
  if (tenant?.geminiApiKey) return tenant.geminiApiKey;
  const config = getConfig();
  if (config.GEMINI_API_KEY) return config.GEMINI_API_KEY;
  throw new Error(`No Gemini API key configured for tenant ${tenantId} or in environment`);
}

interface Category {
  name: string;
  subcategory: string | null;
}

function buildCategorizeSystemPrompt(categories: Category[]): string {
  const hasSubcategories = categories.some((c) => c.subcategory);
  if (hasSubcategories) {
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
    return `You are a medical exam question categorizer. Your task is to categorize Hungarian medical exam questions into a category and subcategory from the following list:\n\n${categoryList}\n\nRules:\n- Choose the SINGLE most appropriate category AND subcategory based on the question content\n- Return the category name AND subcategory name exactly as written above\n- If a question spans multiple topics, choose the PRIMARY topic\n- Consider both the question text and the correct answer when categorizing`;
  }
  const categoryList = categories.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
  return `You are a medical exam question categorizer. Your task is to categorize Hungarian medical exam questions into exactly one of these categories:\n\n${categoryList}\n\nRules:\n- Choose the SINGLE most appropriate category based on the question content\n- Return ONLY the category name exactly as written above\n- If a question spans multiple topics, choose the PRIMARY topic\n- Consider both the question text and the correct answer when categorizing`;
}

function buildCategorizeResponseSchema(categories: Category[]) {
  const hasSubcategories = categories.some((c) => c.subcategory);
  const uniqueNames = [...new Set(categories.map((c) => c.name))];
  const properties: Record<string, { type: SchemaType; enum?: string[]; description?: string }> = {
    category: { type: SchemaType.STRING, enum: uniqueNames },
    reasoning: { type: SchemaType.STRING, description: "Brief explanation for the categorization" },
  };
  const required = ["category", "reasoning"];
  if (hasSubcategories) {
    const uniqueSubcategories = [...new Set(categories.filter((c) => c.subcategory).map((c) => c.subcategory as string))];
    properties.subcategory = { type: SchemaType.STRING, enum: uniqueSubcategories };
    required.push("subcategory");
  }
  return { type: SchemaType.OBJECT, properties, required };
}

// ─── Route registration ──────────────────────────────────────────

export async function questionRoutes(app: FastifyInstance) {
  // GET /api/questions — list all tenant questions (optionally filtered)
  app.get<{
    Querystring: {
      pipelineRunId?: string;
      category?: string;
      subcategory?: string;
      page?: string;
      limit?: string;
      tenantId?: string;
    };
  }>("/api/questions", {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: "object",
        properties: {
          pipelineRunId: { type: "string" },
          category: { type: "string" },
          subcategory: { type: "string" },
          page: { type: "string" },
          limit: { type: "string" },
          tenantId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;
      const { pipelineRunId, category, subcategory, page, limit, tenantId: filterTenantId } = request.query;

      if (!tenantId && role !== "SUPER_ADMIN") {
        return reply.code(400).send({ error: "User must belong to a tenant" });
      }

      // Build filter
      const where: Record<string, unknown> = {};

      if (role === "SUPER_ADMIN" && filterTenantId) {
        // SUPER_ADMIN can filter by explicit tenantId
        where.tenantId = filterTenantId;
      } else if (role === "SUPER_ADMIN" && pipelineRunId) {
        // SUPER_ADMIN can query by pipelineRunId across tenants
        const run = await db.pipelineRun.findUnique({ where: { id: pipelineRunId } });
        if (!run) return reply.code(404).send({ error: "Pipeline run not found" });
        where.tenantId = run.tenantId;
      } else if (tenantId) {
        where.tenantId = tenantId;
      }

      if (pipelineRunId) {
        where.pipelineRunId = pipelineRunId;
      }

      // Filter by category or subcategory (stored in categorization JSON)
      if (subcategory) {
        where.categorization = { path: ["subcategory"], equals: subcategory };
      } else if (category) {
        where.categorization = { path: ["category"], equals: category };
      }

      const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(limit ?? "100", 10) || 100));

      const [questions, total] = await Promise.all([
        db.question.findMany({
          where,
          orderBy: [{ file: "asc" }],
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
        }),
        db.question.count({ where }),
      ]);

      return {
        questions: questions.map((q) => ({
          id: q.id,
          file: q.file,
          sourcePdf: q.sourcePdf,
          success: q.success,
          data: q.data,
          categorization: q.categorization,
          similarityGroupId: q.similarityGroupId,
          pipelineRunId: q.pipelineRunId,
          createdAt: q.createdAt,
          updatedAt: q.updatedAt,
        })),
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    },
  });

  // GET /api/questions/flagged — list questions marked as wrong
  app.get<{
    Querystring: { tenantId?: string; page?: string; limit?: string };
  }>("/api/questions/flagged", {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          page: { type: "string" },
          limit: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId: userTenantId } = request.user;
      const { tenantId: filterTenantId, page, limit } = request.query;

      const where: Record<string, unknown> = { markedWrong: true };

      if (role !== "SUPER_ADMIN") {
        if (!userTenantId) return reply.code(400).send({ error: "User must belong to a tenant" });
        where.tenantId = userTenantId;
      } else if (filterTenantId) {
        where.tenantId = filterTenantId;
      }

      const pageNum = Math.max(1, parseInt(page ?? "1", 10) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(limit ?? "50", 10) || 50));

      const [questions, total] = await Promise.all([
        db.question.findMany({
          where,
          orderBy: [{ markedWrongAt: "desc" }],
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
          include: { tenant: { select: { name: true, slug: true } } },
        }),
        db.question.count({ where }),
      ]);

      return {
        questions: questions.map((q) => ({
          id: q.id,
          tenantId: q.tenantId,
          tenantName: q.tenant.name,
          tenantSlug: q.tenant.slug,
          file: q.file,
          sourcePdf: q.sourcePdf,
          success: q.success,
          data: q.data,
          categorization: q.categorization,
          similarityGroupId: q.similarityGroupId,
          pipelineRunId: q.pipelineRunId,
          markedWrong: q.markedWrong,
          markedWrongAt: q.markedWrongAt,
          createdAt: q.createdAt,
          updatedAt: q.updatedAt,
        })),
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    },
  });

  // POST /api/questions/:id/reparse — re-run Gemini parse on the question's image
  app.post<{ Params: { id: string } }>("/api/questions/:id/reparse", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      const question = await db.question.findUnique({ where: { id: request.params.id } });
      if (!question) return reply.code(404).send({ error: "Question not found" });
      if (role !== "SUPER_ADMIN" && question.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Question not found" });
      }

      if (!question.pipelineRunId || !question.sourcePdf) {
        return reply.code(400).send({ error: "Question has no associated pipeline run or source PDF" });
      }

      // Find image file on disk
      const imagePath = join(config.OUTPUT_DIR, question.tenantId, question.pipelineRunId, question.sourcePdf, question.file);
      let imageData: Buffer;
      try {
        imageData = await readFile(imagePath);
      } catch {
        return reply.code(400).send({ error: "Question image file not found on disk" });
      }

      // Call Gemini to reparse
      const apiKey = await getGeminiApiKey(question.tenantId);
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

      const base64Image = imageData.toString("base64");
      const result = await model.generateContent([
        { inlineData: { mimeType: "image/png", data: base64Image } },
        { text: PARSE_SYSTEM_PROMPT },
      ]);

      const parsed = JSON.parse(result.response.text());

      // Update question in DB
      const updated = await db.question.update({
        where: { id: question.id },
        data: { data: parsed, success: true },
      });

      return {
        id: updated.id,
        file: updated.file,
        data: updated.data,
        success: updated.success,
      };
    },
  });

  // POST /api/questions/:id/recategorize — re-run categorization on the question
  app.post<{ Params: { id: string } }>("/api/questions/:id/recategorize", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const question = await db.question.findUnique({ where: { id: request.params.id } });
      if (!question) return reply.code(404).send({ error: "Question not found" });
      if (role !== "SUPER_ADMIN" && question.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Question not found" });
      }

      const data = question.data as { question_text?: string; correct_answer?: string } | null;
      if (!data?.question_text) {
        return reply.code(400).send({ error: "Question has no parsed text data" });
      }

      // Load tenant categories
      const categories = await db.tenantCategory.findMany({
        where: { tenantId: question.tenantId },
        select: { name: true, subcategory: true },
      });

      if (categories.length === 0) {
        return reply.code(400).send({ error: "Tenant has no categories configured" });
      }

      const apiKey = await getGeminiApiKey(question.tenantId);
      const systemPrompt = buildCategorizeSystemPrompt(categories);
      const responseSchema = buildCategorizeResponseSchema(categories);

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: systemPrompt,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseSchema,
        },
      });

      const prompt = `Categorize this Hungarian medical exam question:\n\nQuestion: ${data.question_text}\n\nCorrect Answer: ${data.correct_answer ?? ""}`;
      const result = await model.generateContent(prompt);
      const parsed = JSON.parse(result.response.text());

      const categorization = {
        success: true,
        category: parsed.category ?? "",
        ...(parsed.subcategory ? { subcategory: parsed.subcategory } : {}),
        reasoning: parsed.reasoning ?? "",
      };

      const updated = await db.question.update({
        where: { id: question.id },
        data: { categorization },
      });

      return {
        id: updated.id,
        file: updated.file,
        categorization: updated.categorization,
      };
    },
  });

  // PATCH /api/questions/:id — manually update question data or answer
  app.patch<{
    Params: { id: string };
    Body: {
      data?: {
        question_text?: string;
        correct_answer?: string;
        question_type?: string;
        points?: number;
        options?: string[];
        question_number?: string;
      };
      categorization?: {
        category?: string;
        subcategory?: string;
      };
    };
  }>("/api/questions/:id", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const question = await db.question.findUnique({ where: { id: request.params.id } });
      if (!question) return reply.code(404).send({ error: "Question not found" });
      if (role !== "SUPER_ADMIN" && question.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Question not found" });
      }

      const updateData: Record<string, unknown> = {};

      // Merge data fields
      if (request.body?.data) {
        const existingData = (question.data ?? {}) as Record<string, unknown>;
        updateData.data = { ...existingData, ...request.body.data };
      }

      // Merge categorization fields
      if (request.body?.categorization) {
        const existingCat = (question.categorization ?? {}) as Record<string, unknown>;
        updateData.categorization = { ...existingCat, ...request.body.categorization, success: true };
      }

      if (Object.keys(updateData).length === 0) {
        return reply.code(400).send({ error: "No fields to update" });
      }

      const updated = await db.question.update({
        where: { id: question.id },
        data: updateData,
      });

      return {
        id: updated.id,
        file: updated.file,
        data: updated.data,
        categorization: updated.categorization,
        success: updated.success,
      };
    },
  });

  // GET /api/questions/:id/image — serve the question's source image
  // Accepts token via Authorization header or ?token= query param (for <img> tags)
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/api/questions/:id/image", {
    schema: { querystring: { type: "object", properties: { token: { type: "string" } } } },
    preHandler: [async (request, reply) => {
      if (!request.headers.authorization && request.query.token) {
        request.headers.authorization = `Bearer ${request.query.token}`;
      }
      return app.authenticate(request, reply);
    }],
    handler: async (request, reply) => {
      const db = getDb();
      const config = getConfig();
      const { role, tenantId } = request.user;

      const question = await db.question.findUnique({ where: { id: request.params.id } });
      if (!question) return reply.code(404).send({ error: "Question not found" });
      if (role !== "SUPER_ADMIN" && question.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Question not found" });
      }

      if (!question.pipelineRunId || !question.sourcePdf) {
        return reply.code(400).send({ error: "Question has no associated pipeline run or source PDF" });
      }

      const imagePath = join(config.OUTPUT_DIR, question.tenantId, question.pipelineRunId, question.sourcePdf, question.file);
      let imageData: Buffer;
      try {
        imageData = await readFile(imagePath);
      } catch {
        return reply.code(404).send({ error: "Image file not found on disk" });
      }

      const ext = question.file.toLowerCase();
      const mime = ext.endsWith(".png") ? "image/png" : ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream";
      return reply.header("Content-Type", mime).header("Cache-Control", "private, max-age=3600").send(imageData);
    },
  });

  // POST /api/questions/:id/resolve — remove wrong marker
  app.post<{ Params: { id: string } }>("/api/questions/:id/resolve", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const question = await db.question.findUnique({ where: { id: request.params.id } });
      if (!question) return reply.code(404).send({ error: "Question not found" });
      if (role !== "SUPER_ADMIN" && question.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Question not found" });
      }

      const updated = await db.question.update({
        where: { id: question.id },
        data: { markedWrong: false, markedWrongAt: null },
      });

      return {
        id: updated.id,
        file: updated.file,
        markedWrong: updated.markedWrong,
      };
    },
  });
}
