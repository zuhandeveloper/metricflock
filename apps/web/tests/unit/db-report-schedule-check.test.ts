import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// A-DB-17: ReportSchedule.dayOfWeek/hourUtc had no DB CHECK — the 0–6 /
// 0–23 ranges were enforced only at the reports/schedule route (zod), so a
// future writer (worker, script, direct SQL) could store e.g. dayOfWeek: 9,
// which the due-window path (getUTCDay 0-6) never matches — a silently dead
// schedule. And TwoFactor carried an index on the encrypted `secret` column,
// which nothing looks up (better-auth's two-factor plugin queries twoFactor
// by userId only — verified against better-auth 1.7.27 dist: all 7 findOne
// sites filter by userId, none by secret).
//
// These are the finding's static checks: they read the schema and the
// migration SQL and assert both halves landed. They run in the unit suite,
// which runs in CI. The finding's live-DB proofs — a direct-SQL insert of
// dayOfWeek: 9 must fail, and EXPLAIN of the TOTP lookup path — need a live
// Postgres and are NOT proven here (CI's smoke step runs `prisma migrate
// deploy` against real Postgres, which is the real gate for the migration
// SQL landing correctly).
const dbDir = path.resolve(process.cwd(), "..", "..", "packages", "db");
const schemaText = fs.readFileSync(path.join(dbDir, "prisma", "schema.prisma"), "utf8");

function modelBlock(model: string): string {
  const match = schemaText.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`, "m"));
  if (!match) throw new Error(`model ${model} not found in schema.prisma`);
  return match[0];
}

describe("ReportSchedule range CHECK + TwoFactor secret index (A-DB-17)", () => {
  it("schema: TwoFactor has no secret index, userId index kept", () => {
    const block = modelBlock("TwoFactor");
    expect(block).not.toMatch(/@@index\(\[secret\]\)/);
    expect(block).toMatch(/@@index\(\[userId\]\)/);
  });

  it("migration: carries the ReportSchedule CHECK and the secret-index drop", () => {
    const migrationsDir = path.join(dbDir, "prisma", "migrations");
    const dir = fs.readdirSync(migrationsDir).find((d) => d.endsWith("_db17_report_schedule_range_check"));
    if (!dir) {
      throw new Error("A-DB-17 migration directory (*_db17_report_schedule_range_check) not found");
    }
    const sql = fs.readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_day_hour_range_check"/);
    expect(sql).toMatch(/CHECK \("dayOfWeek" BETWEEN 0 AND 6 AND "hourUtc" BETWEEN 0 AND 23\)/);
    expect(sql).toMatch(/DROP INDEX "TwoFactor_secret_idx"/);
  });
});
