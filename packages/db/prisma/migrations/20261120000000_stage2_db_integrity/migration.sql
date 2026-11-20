-- Stage 2 — Database integrity (audit DB-1, DB-2, DB-3, DB-7, DB-8, DB-13).
--
-- What this migration does:
--   1. Adds typed owner FK columns (teamId / websiteId) to GoogleConnection
--      and backfills them from the legacy polymorphic ownerType/ownerId
--      (only where the owner exists in the same organization; rows whose
--      owner no longer exists keep NULL typed owners and stay reachable via
--      the legacy columns until they are dropped in a later release).
--   2. Enforces same-organization relations with composite FKs:
--      Website.teamId -> Team(id, organizationId),
--      GoogleConnection.teamId/websiteId -> (id, organizationId).
--      Pre-flight: websites pointing at another organization's team
--      (possible via the old API-1 bug) are unassigned (teamId = NULL)
--      instead of failing the migration. No rows are deleted.
--   3. Guarantees at most one primary integration per (website, provider)
--      with a partial unique index (pre-flight keeps the newest primary).
--   4. Backfills WebsiteIntegration connection/property FKs where exactly
--      one discovered property matches in the website's organization.
--   5. Adds scheduler/resolution indexes; drops two redundant indexes.
--
-- Rollback: all changes are additive except the dropped redundant indexes
-- (recreate them) and the pre-flight repairs (cross-org teamId null-outs
-- and primary demotions affect only rows that already violated the new
-- rules). The legacy ownerType/ownerId columns are NOT dropped here.

-- DropForeignKey
ALTER TABLE "Website" DROP CONSTRAINT "Website_teamId_fkey";

-- Pre-flight (DB-2): unassign websites whose team belongs to a different
-- organization, so the composite FK below can be created.
UPDATE "Website" w
SET "teamId" = NULL
WHERE w."teamId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Team" t
    WHERE t."id" = w."teamId" AND t."organizationId" = w."organizationId"
  );

-- DropIndex (DB-13: redundant with the unique index on slug; Prisma's diff
-- does not emit this drop, added by hand)
DROP INDEX "Organization_slug_idx";

-- DropIndex
DROP INDEX "GoogleProperty_connectionId_idx";

-- DropIndex
DROP INDEX "AnalyticsSyncJob_websiteId_type_status_idx";

-- AlterTable
ALTER TABLE "GoogleConnection" ADD COLUMN     "teamId" TEXT,
ADD COLUMN     "websiteId" TEXT;

-- Backfill (DB-1): typed owners from the legacy polymorphic owner, only
-- where the owner exists in the same organization.
UPDATE "GoogleConnection" gc
SET "teamId" = gc."ownerId"
WHERE gc."ownerType" = 'TEAM'
  AND EXISTS (
    SELECT 1 FROM "Team" t
    WHERE t."id" = gc."ownerId" AND t."organizationId" = gc."organizationId"
  );

UPDATE "GoogleConnection" gc
SET "websiteId" = gc."ownerId"
WHERE gc."ownerType" = 'WEBSITE'
  AND EXISTS (
    SELECT 1 FROM "Website" w
    WHERE w."id" = gc."ownerId" AND w."organizationId" = gc."organizationId"
  );

-- A connection has at most one typed owner. (Both NULL = legacy orphan
-- whose owner no longer exists; new code always writes exactly one.
-- Tighten to exactly-one when the legacy columns are dropped.)
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_single_owner_check"
  CHECK (NOT ("teamId" IS NOT NULL AND "websiteId" IS NOT NULL));

-- Pre-flight (DB-3): keep only the newest primary per (website, provider).
UPDATE "WebsiteIntegration"
SET "isPrimary" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "websiteId", "provider"
             ORDER BY "updatedAt" DESC, "createdAt" DESC
           ) AS rn
    FROM "WebsiteIntegration"
    WHERE "isPrimary" = true
  ) ranked
  WHERE rn > 1
);

-- At most one primary integration per (website, provider).
CREATE UNIQUE INDEX "WebsiteIntegration_one_primary_per_provider"
  ON "WebsiteIntegration" ("websiteId", "provider")
  WHERE "isPrimary" = true;

-- Scheduler scans mapped integrations (DB-8).
CREATE INDEX "WebsiteIntegration_mapped_idx"
  ON "WebsiteIntegration" ("websiteId", "provider")
  WHERE "mappingStatus" = 'MAPPED';

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_organizationId_key" ON "Team"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Website_id_organizationId_key" ON "Website"("id", "organizationId");

-- CreateIndex
CREATE INDEX "GoogleConnection_organizationId_teamId_status_idx" ON "GoogleConnection"("organizationId", "teamId", "status");

-- CreateIndex
CREATE INDEX "GoogleConnection_organizationId_websiteId_status_idx" ON "GoogleConnection"("organizationId", "websiteId", "status");

-- CreateIndex
CREATE INDEX "GoogleConnection_status_tokenExpiresAt_idx" ON "GoogleConnection"("status", "tokenExpiresAt");

-- CreateIndex
CREATE INDEX "AnalyticsSyncJob_websiteId_type_status_updatedAt_idx" ON "AnalyticsSyncJob"("websiteId", "type", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "Website" ADD CONSTRAINT "Website_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "Website"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (DB-7): link existing integrations to their discovered property
-- and connection where exactly one match exists in the website's
-- organization. Ambiguous or undiscovered mappings stay NULL (the map API
-- now writes these FKs for every new mapping).
UPDATE "WebsiteIntegration" wi
SET "googlePropertyId" = gp."id", "googleConnectionId" = gp."connectionId"
FROM "GoogleProperty" gp
JOIN "GoogleConnection" gc ON gc."id" = gp."connectionId"
JOIN "Website" w ON w."id" = wi."websiteId"
WHERE wi."provider" = 'GA4'
  AND wi."googleConnectionId" IS NULL
  AND gp."propertyId" = wi."externalId"
  AND gc."organizationId" = w."organizationId"
  AND (
    SELECT COUNT(*) FROM "GoogleProperty" gp2
    JOIN "GoogleConnection" gc2 ON gc2."id" = gp2."connectionId"
    WHERE gp2."propertyId" = wi."externalId" AND gc2."organizationId" = w."organizationId"
  ) = 1;

UPDATE "WebsiteIntegration" wi
SET "searchConsolePropertyId" = sp."id", "googleConnectionId" = sp."connectionId"
FROM "SearchConsoleProperty" sp
JOIN "GoogleConnection" gc ON gc."id" = sp."connectionId"
JOIN "Website" w ON w."id" = wi."websiteId"
WHERE wi."provider" = 'SEARCH_CONSOLE'
  AND wi."googleConnectionId" IS NULL
  AND sp."siteUrl" = wi."externalId"
  AND gc."organizationId" = w."organizationId"
  AND (
    SELECT COUNT(*) FROM "SearchConsoleProperty" sp2
    JOIN "GoogleConnection" gc2 ON gc2."id" = sp2."connectionId"
    WHERE sp2."siteUrl" = wi."externalId" AND gc2."organizationId" = w."organizationId"
  ) = 1;

UPDATE "WebsiteIntegration" wi
SET "adsenseAccountId" = aa."id", "googleConnectionId" = aa."connectionId"
FROM "AdSenseAccount" aa
JOIN "GoogleConnection" gc ON gc."id" = aa."connectionId"
JOIN "Website" w ON w."id" = wi."websiteId"
WHERE wi."provider" = 'ADSENSE'
  AND wi."googleConnectionId" IS NULL
  AND aa."accountId" = wi."externalId"
  AND gc."organizationId" = w."organizationId"
  AND (
    SELECT COUNT(*) FROM "AdSenseAccount" aa2
    JOIN "GoogleConnection" gc2 ON gc2."id" = aa2."connectionId"
    WHERE aa2."accountId" = wi."externalId" AND gc2."organizationId" = w."organizationId"
  ) = 1;

UPDATE "WebsiteIntegration" wi
SET "adManagerNetworkId" = an."id", "googleConnectionId" = an."connectionId"
FROM "AdManagerNetwork" an
JOIN "GoogleConnection" gc ON gc."id" = an."connectionId"
JOIN "Website" w ON w."id" = wi."websiteId"
WHERE wi."provider" = 'AD_MANAGER'
  AND wi."googleConnectionId" IS NULL
  AND an."networkCode" = wi."externalId"
  AND gc."organizationId" = w."organizationId"
  AND (
    SELECT COUNT(*) FROM "AdManagerNetwork" an2
    JOIN "GoogleConnection" gc2 ON gc2."id" = an2."connectionId"
    WHERE an2."networkCode" = wi."externalId" AND gc2."organizationId" = w."organizationId"
  ) = 1;
