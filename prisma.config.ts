// Prisma 7 config. The datasource URL no longer lives in schema.prisma —
// it is defined here for `prisma migrate` / `prisma generate`. The runtime
// client does NOT read this file: src/lib/prisma.ts passes a pg driver
// adapter (PrismaPg) to PrismaClient instead (required in Prisma 7).
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
