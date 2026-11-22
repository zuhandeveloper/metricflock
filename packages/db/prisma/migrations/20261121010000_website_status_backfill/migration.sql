-- Backfill: websites that already have a MAPPED integration but are
-- still PENDING_SETUP (created before the map route started flipping
-- the status) become ACTIVE. Idempotent; safe to re-run.
UPDATE "Website" w
SET "status" = 'ACTIVE'
WHERE w."status" = 'PENDING_SETUP'
  AND EXISTS (
    SELECT 1 FROM "WebsiteIntegration" i
    WHERE i."websiteId" = w."id" AND i."mappingStatus" = 'MAPPED'
  );
