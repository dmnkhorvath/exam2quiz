import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";

export async function tenantSettingsRoutes(app: FastifyInstance) {
  const requireTenantMember = app.requireRole("TENANT_ADMIN", "TENANT_USER");
  const requireAuth = app.authenticate;

  // GET /api/tenant/settings — any authenticated tenant member can view (key is masked)
  app.get("/api/tenant/settings", {
    preHandler: [requireAuth],
    handler: async (request, reply) => {
      const { tenantId } = request.user;
      if (!tenantId) {
        return reply.code(400).send({ error: "No tenant associated with this user" });
      }

      const db = getDb();
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, slug: true, geminiApiKey: true },
      });

      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found" });
      }

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        hasGeminiApiKey: !!tenant.geminiApiKey,
        geminiApiKeyMasked: tenant.geminiApiKey
          ? `${"*".repeat(Math.max(0, tenant.geminiApiKey.length - 4))}${tenant.geminiApiKey.slice(-4)}`
          : null,
      };
    },
  });

  // PUT /api/tenant/settings — TENANT_ADMIN can update their own tenant's gemini key
  app.put<{
    Body: { geminiApiKey?: string | null };
  }>("/api/tenant/settings", {
    preHandler: [requireTenantMember],
    schema: {
      body: {
        type: "object",
        properties: {
          geminiApiKey: { type: ["string", "null"] },
        },
      },
    },
    handler: async (request, reply) => {
      const { tenantId } = request.user;
      if (!tenantId) {
        return reply.code(400).send({ error: "No tenant associated with this user" });
      }

      const db = getDb();
      const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        return reply.code(404).send({ error: "Tenant not found" });
      }

      const updated = await db.tenant.update({
        where: { id: tenantId },
        data: { geminiApiKey: request.body.geminiApiKey ?? null },
        select: { id: true, name: true, slug: true, geminiApiKey: true },
      });

      return {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        hasGeminiApiKey: !!updated.geminiApiKey,
        geminiApiKeyMasked: updated.geminiApiKey
          ? `${"*".repeat(Math.max(0, updated.geminiApiKey.length - 4))}${updated.geminiApiKey.slice(-4)}`
          : null,
      };
    },
  });
}
