import { PrismaClient, Prisma } from "@prisma/client";
// Prisma 7 requires a driver adapter on the client: the datasource URL in
// prisma.config.ts only serves `prisma migrate` / `prisma generate`. At
// runtime the client connects through pg. The Pool is lazy — constructing
// it with a placeholder DATABASE_URL at build time opens no connection.
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

export type { Prisma };

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
