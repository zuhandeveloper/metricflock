-- Stage 5 (OPS-3/OPS-4): idempotent job bookkeeping.
-- AnalyticsSyncJob.externalId becomes unique (one row per BullMQ job,
-- upserted across attempts instead of one row per attempt) and gains a
-- payload column so failed jobs keep their input for inspection/requeue.
-- IntegrationHealth becomes current-state per (websiteId, provider).
-- Pre-flight dedupes keep the newest row per key. Rollback: drop the two
-- unique indexes and the payload column.
DELETE FROM "AnalyticsSyncJob" a USING "AnalyticsSyncJob" b
WHERE a."externalId" IS NOT NULL AND a."externalId" = b."externalId"
  AND (a."updatedAt" < b."updatedAt" OR (a."updatedAt" = b."updatedAt" AND a."id" < b."id"));
DELETE FROM "IntegrationHealth" a USING "IntegrationHealth" b
WHERE a."websiteId" IS NOT NULL AND a."websiteId" = b."websiteId" AND a."provider" = b."provider"
  AND (a."checkedAt" < b."checkedAt" OR (a."checkedAt" = b."checkedAt" AND a."id" < b."id"));

-- AlterTable
ALTER TABLE "AnalyticsSyncJob" ADD COLUMN     "payload" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSyncJob_externalId_key" ON "AnalyticsSyncJob"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationHealth_websiteId_provider_key" ON "IntegrationHealth"("websiteId", "provider");

