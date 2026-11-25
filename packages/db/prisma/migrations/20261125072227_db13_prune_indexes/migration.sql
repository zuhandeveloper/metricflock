-- A-DB-13: `OrganizationInvite` had no index on `expiresAt`, so the new
-- scheduler sweep for expired invites (apps/worker/src/scheduler.ts)
-- would seq-scan the table every tick. The schema now declares
-- `@@index([expiresAt])`; this migration adds the index. Adding an
-- index is safe on a non-empty table (single statement, no data
-- change), so no pre-flight query or backfill is needed.
--
-- This SQL is the `prisma migrate diff --from-schema <before> --to-schema
-- <after> --script` output, used verbatim.

-- CreateIndex
CREATE INDEX "OrganizationInvite_expiresAt_idx" ON "OrganizationInvite"("expiresAt");
