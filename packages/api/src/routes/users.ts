import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { hashPassword } from "../plugins/auth.js";

export async function userRoutes(app: FastifyInstance) {
  const requireAdmin = app.requireRole("SUPER_ADMIN", "TENANT_ADMIN");

  // GET /api/users
  app.get("/api/users", {
    preHandler: [requireAdmin],
    handler: async (request) => {
      const db = getDb();
      const { role, tenantId } = request.user;

      // TENANT_ADMIN can only see users in their tenant
      const where = role === "SUPER_ADMIN" ? {} : { tenantId: tenantId! };

      return db.user.findMany({
        where,
        select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
    },
  });

  // POST /api/users
  app.post<{
    Body: { email: string; password: string; name?: string; role?: string; tenantId?: string };
  }>("/api/users", {
    preHandler: [requireAdmin],
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
          name: { type: "string" },
          role: { type: "string", enum: ["TENANT_ADMIN", "TENANT_USER"] },
          tenantId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { email, password, name, role, tenantId } = request.body;
      const caller = request.user;

      // TENANT_ADMIN can only create users in their own tenant
      const targetTenantId = caller.role === "SUPER_ADMIN" ? tenantId : caller.tenantId;
      // TENANT_ADMIN cannot create SUPER_ADMIN
      const assignedRole = caller.role === "SUPER_ADMIN"
        ? (role as "TENANT_ADMIN" | "TENANT_USER") ?? "TENANT_USER"
        : "TENANT_USER";

      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const user = await db.user.create({
        data: { email, passwordHash, name, role: assignedRole, tenantId: targetTenantId },
        select: { id: true, email: true, name: true, role: true, tenantId: true, createdAt: true },
      });
      return reply.code(201).send(user);
    },
  });

  // PUT /api/users/:id
  app.put<{
    Params: { id: string };
    Body: { name?: string; role?: string; isActive?: boolean; tenantId?: string };
  }>("/api/users/:id", {
    preHandler: [requireAdmin],
    schema: {
      body: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string", enum: ["TENANT_ADMIN", "TENANT_USER"] },
          isActive: { type: "boolean" },
          tenantId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const caller = request.user;
      const targetUser = await db.user.findUnique({ where: { id: request.params.id } });

      if (!targetUser) {
        return reply.code(404).send({ error: "User not found" });
      }

      // TENANT_ADMIN can only modify users in their tenant
      if (caller.role === "TENANT_ADMIN" && targetUser.tenantId !== caller.tenantId) {
        return reply.code(403).send({ error: "Cannot modify users outside your tenant" });
      }

      // Build safe update data
      const data: Record<string, unknown> = {};
      if (request.body.name !== undefined) data.name = request.body.name;
      if (request.body.isActive !== undefined) data.isActive = request.body.isActive;
      if (caller.role === "SUPER_ADMIN") {
        if (request.body.role !== undefined) data.role = request.body.role;
        if (request.body.tenantId !== undefined) data.tenantId = request.body.tenantId;
      }

      const updated = await db.user.update({
        where: { id: request.params.id },
        data,
        select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true, updatedAt: true },
      });
      return updated;
    },
  });

  // DELETE /api/users/:id (soft delete)
  app.delete<{ Params: { id: string } }>("/api/users/:id", {
    preHandler: [requireAdmin],
    handler: async (request, reply) => {
      const db = getDb();
      const caller = request.user;
      const targetUser = await db.user.findUnique({ where: { id: request.params.id } });

      if (!targetUser) {
        return reply.code(404).send({ error: "User not found" });
      }

      if (caller.role === "TENANT_ADMIN" && targetUser.tenantId !== caller.tenantId) {
        return reply.code(403).send({ error: "Cannot modify users outside your tenant" });
      }

      // Prevent self-deactivation
      if (targetUser.id === caller.sub) {
        return reply.code(400).send({ error: "Cannot deactivate yourself" });
      }

      await db.user.update({
        where: { id: request.params.id },
        data: { isActive: false },
      });
      return reply.code(204).send();
    },
  });
}
