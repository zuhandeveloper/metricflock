-- A-API-14: `AnalyticsCache` had no `updatedAt` column, so
-- `readSnapshot`/`readSnapshots` (packages/db/src/snapshots.ts) returned
-- `createdAt` as `updatedAt` and `snapshotUpdatedAt` never advanced after
-- the first write. The schema now declares `updatedAt DateTime
-- @updatedAt`; Prisma maintains it on every upsert update, and the read
-- functions select and return it (docs/audit/02-API-FUNCTIONAL-AUDIT.md).
--
-- This SQL is the `prisma migrate diff --from-schema <before> --to-schema
-- <after> --script` output, adjusted for a NON-EMPTY table: the raw diff
-- emits a single `ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL`, which
-- Postgres rejects when the table already has rows (existing rows would
-- be NULL). Instead the column is added nullable, backfilled, then made
-- NOT NULL — the end state is byte-identical to the diff's target
-- (`TIMESTAMP(3) NOT NULL`, no default, matching every other `@updatedAt`
-- column in this schema; the Prisma client always sends an explicit
-- value on writes).
--
-- Backfill choice: `createdAt`. For a row never rewritten, createdAt IS
-- its last write; for a rewritten row the true last-write time is
-- unrecoverable, and createdAt is the best available value — it is also
-- exactly what the old code reported, so no dashboard regresses on
-- deploy. No pre-flight query is needed: the UPDATE covers every row by
-- construction, so the final SET NOT NULL cannot fail.

-- Add the column nullable first (safe on a table with existing rows).
ALTER TABLE "AnalyticsCache" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Backfill from the first-write time (see header).
UPDATE "AnalyticsCache" SET "updatedAt" = "createdAt";

-- Now the column matches the Prisma model exactly.
ALTER TABLE "AnalyticsCache" ALTER COLUMN "updatedAt" SET NOT NULL;
