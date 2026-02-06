import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";

export async function tenantRoutes(app: FastifyInstance) {
  const requireSuperAdmin = app.requireRole("SUPER_ADMIN");

  // GET /api/tenants
  app.get("/api/tenants", {
    preHandler: [requireSuperAdmin],
    handler: async () => {
      const db = getDb();
      return db.tenant.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { users: true, pipelineRuns: true } } },
      });
    },
  });

  // POST /api/tenants
  app.post<{
    Body: { name: string; slug: string; geminiApiKey?: string; maxConcurrentPipelines?: number; storageQuotaMb?: number };
  }>("/api/tenants", {
    preHandler: [requireSuperAdmin],
    schema: {
      body: {
        type: "object",
        required: ["name", "slug"],
        properties: {
          name: { type: "string", minLength: 1 },
          slug: { type: "string", pattern: "^[a-z0-9-]+$" },
          geminiApiKey: { type: "string" },
          maxConcurrentPipelines: { type: "number", minimum: 1 },
          storageQuotaMb: { type: "number", minimum: 100 },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { name, slug, geminiApiKey, maxConcurrentPipelines, storageQuotaMb } = request.body;

      const existing = await db.tenant.findUnique({ where: { slug } });
      if (existing) {
        return reply.code(409).send({ error: "Slug already in use" });
      }

      const tenant = await db.tenant.create({
        data: { name, slug, geminiApiKey, maxConcurrentPipelines, storageQuotaMb },
      });
      return reply.code(201).send(tenant);
    },
  });

  // GET /api/tenants/:id
  app.get<{ Params: { id: string } }>("/api/tenants/:id", {
    preHandler: [requireSuperAdmin],
    handler: async (request, reply) => {
      const db = getDb();
      const tenant = await db.tenant.findUnique({
        where: { id: request.params.id },
        include: { _count: { select: { users: true, pipelineRuns: true, categories: true } } },
      });
      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found" });
      }
      return tenant;
    },
  });

  // PUT /api/tenants/:id
  app.put<{
    Params: { id: string };
    Body: { name?: string; slug?: string; geminiApiKey?: string; maxConcurrentPipelines?: number; storageQuotaMb?: number; isActive?: boolean };
  }>("/api/tenants/:id", {
    preHandler: [requireSuperAdmin],
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          slug: { type: "string", pattern: "^[a-z0-9-]+$" },
          geminiApiKey: { type: "string" },
          maxConcurrentPipelines: { type: "number", minimum: 1 },
          storageQuotaMb: { type: "number", minimum: 100 },
          isActive: { type: "boolean" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const tenant = await db.tenant.findUnique({ where: { id: request.params.id } });
      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found" });
      }

      const updated = await db.tenant.update({
        where: { id: request.params.id },
        data: request.body,
      });
      return updated;
    },
  });

  // DELETE /api/tenants/:id (soft delete)
  app.delete<{ Params: { id: string } }>("/api/tenants/:id", {
    preHandler: [requireSuperAdmin],
    handler: async (request, reply) => {
      const db = getDb();
      const tenant = await db.tenant.findUnique({ where: { id: request.params.id } });
      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found" });
      }

      await db.tenant.update({
        where: { id: request.params.id },
        data: { isActive: false },
      });
      return reply.code(204).send();
    },
  });
}
