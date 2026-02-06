import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import fjwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { getConfig } from "@exams2quiz/shared/config";
import { getDb } from "@exams2quiz/shared/db";
import type { UserRole } from "@prisma/client";

// Extend Fastify types for JWT user payload
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: UserRole; tenantId: string | null };
    user: { sub: string; email: string; role: UserRole; tenantId: string | null };
  }
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance) {
  const config = getConfig();

  await app.register(fjwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });

  // Decorator: require authentication
  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Decorator: require specific roles
  app.decorate(
    "requireRole",
    function (...roles: UserRole[]) {
      return async function (request: FastifyRequest, reply: FastifyReply) {
        try {
          await request.jwtVerify();
        } catch {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        if (!roles.includes(request.user.role)) {
          return reply.code(403).send({ error: "Forbidden" });
        }
      };
    },
  );
});

// Extend Fastify instance type
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: UserRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ─── Password helpers ───────────────────────────────────────────
const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── User lookup helper ─────────────────────────────────────────
export async function findUserByEmail(email: string) {
  const db = getDb();
  return db.user.findUnique({ where: { email }, include: { tenant: true } });
}
