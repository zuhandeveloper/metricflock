// Dev database helper: `pnpm db:status` / `pnpm db:reset`.
// status: checks DATABASE_URL connectivity and reports applied vs pending
// migrations (via `prisma migrate status`). Never modifies data.
// reset: DEV ONLY — drops and recreates the database, applies all migrations
// and re-seeds. Refuses to run when NODE_ENV=production.
import "dotenv/config";
import { execFileSync } from "node:child_process";

const cmd = process.argv[2];

function run(args: string[]) {
  execFileSync("pnpm", ["exec", "prisma", ...args], { stdio: "inherit" });
}

function checkDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Copy apps/web/.env.example to apps/web/.env and fill it in.");
    process.exit(1);
  }
}

if (cmd === "status") {
  checkDatabaseUrl();
  console.log("Checking database connectivity and migration status…");
  run(["migrate", "status"]);
} else if (cmd === "reset") {
  if (process.env.NODE_ENV === "production") {
    console.error("db:reset refuses to run in production.");
    process.exit(1);
  }
  checkDatabaseUrl();
  console.log("DEV ONLY: resetting the database (all data will be lost)…");
  run(["migrate", "reset", "--force"]);
  console.log("Re-seeding…");
  execFileSync("pnpm", ["db:seed"], { stdio: "inherit" });
} else {
  console.error("Usage: tsx scripts/db-manager.ts <status|reset>");
  process.exit(1);
}
