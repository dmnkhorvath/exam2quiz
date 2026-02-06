import type { FastifyInstance } from "fastify";
import { getDb } from "@exams2quiz/shared/db";
import { hashPassword, verifyPassword, findUserByEmail } from "../plugins/auth.js";

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login
  app.post<{
    Body: { email: string; password: string };
  }>("/api/auth/login", {
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 1 },
        },
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body;
      const user = await findUserByEmail(email);

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = app.jwt.sign({
        sub: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      });

      return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId } };
    },
  });

  // POST /api/auth/register (first user is SUPER_ADMIN, subsequent require SUPER_ADMIN)
  app.post<{
    Body: { email: string; password: string; name?: string; role?: string; tenantId?: string };
  }>("/api/auth/register", {
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
          name: { type: "string" },
          role: { type: "string", enum: ["SUPER_ADMIN", "TENANT_ADMIN", "TENANT_USER"] },
          tenantId: { type: "string" },
        },
      },
    },
    handler: async (request, reply) => {
      const db = getDb();
      const { email, password, name, role, tenantId } = request.body;

      // Check if any users exist (first user becomes SUPER_ADMIN)
      const userCount = await db.user.count();
      const isFirstUser = userCount === 0;

      if (!isFirstUser) {
        // Require auth for subsequent registrations
        try {
          await request.jwtVerify();
        } catch {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        if (request.user.role !== "SUPER_ADMIN") {
          return reply.code(403).send({ error: "Only SUPER_ADMIN can register users" });
        }
      }

      // Check duplicate email
      const existing = await db.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: "Email already registered" });
      }

      const passwordHash = await hashPassword(password);
      const assignedRole = isFirstUser ? "SUPER_ADMIN" : (role as "SUPER_ADMIN" | "TENANT_ADMIN" | "TENANT_USER") ?? "TENANT_USER";

      const user = await db.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: assignedRole,
          tenantId: isFirstUser ? undefined : tenantId,
        },
        select: { id: true, email: true, name: true, role: true, tenantId: true, createdAt: true },
      });

      return reply.code(201).send(user);
    },
  });

  // GET /api/auth/me
  app.get("/api/auth/me", {
    preHandler: [app.authenticate],
    handler: async (request) => {
      const db = getDb();
      const user = await db.user.findUnique({
        where: { id: request.user.sub },
        select: { id: true, email: true, name: true, role: true, tenantId: true, isActive: true, createdAt: true },
      });
      if (!user || !user.isActive) {
        throw { statusCode: 401, message: "User not found or inactive" };
      }
      return user;
    },
  });
}
