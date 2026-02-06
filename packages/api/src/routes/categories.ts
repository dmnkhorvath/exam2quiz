import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";

export async function categoryRoutes(app: FastifyInstance) {
  // GET /api/categories — list categories for current tenant
  app.get("/api/categories", {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      const db = getDb();
      const { tenantId } = request.user;

      if (!tenantId) {
        return reply.code(400).send({ error: "User must belong to a tenant" });
      }

      return db.tenantCategory.findMany({
        where: { tenantId },
        orderBy: { sortOrder: "asc" },
      });
    },
  });

  // POST /api/categories
  app.post<{
    Body: { key: string; name: string; file: string; sortOrder?: number };
  }>("/api/categories", {
    preHandler: [app.requireRole("SUPER_ADMIN", "TENANT_ADMIN")],
    schema: {
      body: {
        type: "object",
        required: ["key", "name", "file"],
        properties: {
          key: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          sortOrder: { type: "number" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;
      const { key, name, file, sortOrder } = request.body;

      const targetTenantId = role === "SUPER_ADMIN" ? tenantId : tenantId;
      if (!targetTenantId) {
        return reply.code(400).send({ error: "Tenant context required" });
      }

      // Check uniqueness
      const existing = await db.tenantCategory.findUnique({
        where: { tenantId_key: { tenantId: targetTenantId, key } },
      });
      if (existing) {
        return reply.code(409).send({ error: "Category key already exists for this tenant" });
      }

      const category = await db.tenantCategory.create({
        data: { tenantId: targetTenantId, key, name, file, sortOrder: sortOrder ?? 0 },
      });
      return reply.code(201).send(category);
    },
  });

  // PUT /api/categories/:id
  app.put<{
    Params: { id: string };
    Body: { key?: string; name?: string; file?: string; sortOrder?: number };
  }>("/api/categories/:id", {
    preHandler: [app.requireRole("SUPER_ADMIN", "TENANT_ADMIN")],
    schema: {
      body: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          file: { type: "string", minLength: 1 },
          sortOrder: { type: "number" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const category = await db.tenantCategory.findUnique({ where: { id: request.params.id } });
      if (!category) {
        return reply.code(404).send({ error: "Category not found" });
      }

      // Tenant scoping
      if (role !== "SUPER_ADMIN" && category.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Category not found" });
      }

      const updated = await db.tenantCategory.update({
        where: { id: request.params.id },
        data: request.body,
      });
      return updated;
    },
  });

  // DELETE /api/categories/:id
  app.delete<{ Params: { id: string } }>("/api/categories/:id", {
    preHandler: [app.requireRole("SUPER_ADMIN", "TENANT_ADMIN")],
    handler: async (request, reply) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      const category = await db.tenantCategory.findUnique({ where: { id: request.params.id } });
      if (!category) {
        return reply.code(404).send({ error: "Category not found" });
      }

      if (role !== "SUPER_ADMIN" && category.tenantId !== tenantId) {
        return reply.code(404).send({ error: "Category not found" });
      }

      await db.tenantCategory.delete({ where: { id: request.params.id } });
      return reply.code(204).send();
    },
  });
}
