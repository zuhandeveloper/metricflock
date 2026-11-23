// Dev database helper: `pnpm db:status` / `pnpm db:reset`.
// status: checks DATABASE_URL connectivity and reports applied vs pending
// migrations (via `prisma migrate status`). Never modifies data.
// reset: DEV ONLY — drops and recreates the database, applies all migrations
// and re-seeds. Refuses to run when NODE_ENV=production.
import "dotenv/config";
import { execFileSync } from "node:child_process";

// Dev database helper: `pnpm db:status` / `pnpm db:reset`.
// status: checks DATABASE_URL connectivity and reports applied vs pending
// migrations (via `prisma migrate status`). Never modifies data.
// reset: DEV ONLY — drops and recreates the database, applies all migrations
// and re-seeds. Refuses to run when NODE_ENV=production.
const cmd = process.argv[2];

// Spawning bare `pnpm` fails on shells where pnpm is not on PATH
// (e.g. MSYS2/UCRT64 on Windows: `spawnSync pnpm ENOENT`). When this
// script runs under a package manager, npm_execpath points at it —
// invoke it via node instead. Fall back to a shell lookup otherwise.
function runPnpm(args: string[]) {
  const execpath = process.env.npm_execpath;
  if (execpath) {
    execFileSync(process.execPath, [execpath, ...args], { stdio: "inherit" });
  } else {
    execFileSync("pnpm", args, { stdio: "inherit", shell: process.platform === "win32" });
  }
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
  runPnpm(["exec", "prisma", "migrate", "status"]);
} else if (cmd === "reset") {
  if (process.env.NODE_ENV === "production") {
    console.error("db:reset refuses to run in production.");
    process.exit(1);
  }
  checkDatabaseUrl();
  console.log("DEV ONLY: resetting the database (all data will be lost)…");
  runPnpm(["exec", "prisma", "migrate", "reset", "--force"]);
  console.log("Re-seeding…");
  runPnpm(["db:seed"]);
} else {
  console.error("Usage: tsx scripts/db-manager.ts <status|reset>");
  process.exit(1);
}
