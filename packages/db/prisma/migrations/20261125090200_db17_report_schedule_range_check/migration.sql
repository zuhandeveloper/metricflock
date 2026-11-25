-- A-DB-17: `ReportSchedule.dayOfWeek`/`hourUtc` ranges were enforced only
-- at the route (zod in `apps/web/src/app/api/reports/schedule/route.ts`),
-- with no CHECK in the database; and `TwoFactor` carried an index on the
-- encrypted `secret` column, which nothing looks up (docs/audit/03-DATABASE-AUDIT.md).
--
-- A `dayOfWeek` outside 0-6 (or `hourUtc` outside 0-23) is silently dead:
-- the due-window path compares against `getUTCDay()`/`getUTCHours()`, so a
-- never-sent schedule never fires (a previously-sent one could still fire
-- via the A-WRK-06 catch-up at an arbitrary time). Either way the
-- configured schedule is silently ignored. The `secret` index only added
-- write overhead: better-auth's two-factor plugin looks `twoFactor` up by
-- `userId` only (verified against better-auth 1.7.27 dist — all 7 `findOne`
-- sites filter by `userId`, none by `secret`), and no repo code queries
-- `twoFactor` directly.
--
-- Prisma's schema DSL cannot express CHECK constraints (Prisma 7.10 has no
-- `@@check`), so the CHECK lives here only — the same pattern as the
-- A-DB-07 CHECKs and the A-DB-08 `GoogleConnection_legacy_owner_match_check`.
-- `prisma migrate diff` emits only the `DROP INDEX` below (for the removed
-- `@@index([secret])`); the CHECK is hand-added.
--
-- RISK — READ BEFORE DEPLOY: `ALTER TABLE ... ADD CONSTRAINT` validates
-- every existing row. The reports/schedule route already enforces the
-- ranges (zod), so a healthy database should have zero violating rows —
-- but any row written by a direct-SQL/manual write outside the ranges
-- makes `prisma migrate deploy` FAIL on that database. Do NOT deploy this
-- migration to production until the target DB has been checked and any
-- violating rows repaired (set `dayOfWeek`/`hourUtc` to a valid value,
-- e.g. the route defaults 1/8, or disable/delete the schedule).
-- Pre-flight query (run against the target DB; it must return zero rows):
--
--   SELECT "id", "dayOfWeek", "hourUtc"
--   FROM "ReportSchedule"
--   WHERE "dayOfWeek" NOT BETWEEN 0 AND 6 OR "hourUtc" NOT BETWEEN 0 AND 23;

-- AddCheckConstraint
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_day_hour_range_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6 AND "hourUtc" BETWEEN 0 AND 23);

-- DropIndex
DROP INDEX "TwoFactor_secret_idx";
