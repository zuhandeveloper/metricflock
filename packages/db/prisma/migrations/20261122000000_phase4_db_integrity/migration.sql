-- Phase 4 (F-4.1): database-level tenant-integrity constraints.
--
-- 1. TeamMember / WebsiteAssignment gain organizationId (backfilled from
--    their team/website) and composite FKs, so a user can never be
--    attached to another organization's team or website.
-- 2. WebsiteIntegration property FKs become composite with
--    googleConnectionId, so a mapped property must belong to the
--    integration's own connection.
-- 3. GoogleConnection owner CHECK tightens from "at most one" to
--    "exactly one" typed owner (after a defensive legacy backfill).
--
-- All statements are additive/backfill-safe on existing data: any row
-- that would violate the new constraints makes the migration fail
-- loudly instead of silently corrupting tenant boundaries.

-- DropForeignKey
ALTER TABLE "TeamMember" DROP CONSTRAINT "TeamMember_teamId_fkey";

-- DropForeignKey
ALTER TABLE "TeamMember" DROP CONSTRAINT "TeamMember_userId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteAssignment" DROP CONSTRAINT "WebsiteAssignment_websiteId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteAssignment" DROP CONSTRAINT "WebsiteAssignment_userId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteIntegration" DROP CONSTRAINT "WebsiteIntegration_googlePropertyId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteIntegration" DROP CONSTRAINT "WebsiteIntegration_searchConsolePropertyId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteIntegration" DROP CONSTRAINT "WebsiteIntegration_adsenseAccountId_fkey";

-- DropForeignKey
ALTER TABLE "WebsiteIntegration" DROP CONSTRAINT "WebsiteIntegration_adManagerNetworkId_fkey";

-- AlterTable: add nullable first, backfill, then enforce NOT NULL.
ALTER TABLE "TeamMember" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "WebsiteAssignment" ADD COLUMN "organizationId" TEXT;

-- Backfill (F-4.1): organization from the owning team / website.
UPDATE "TeamMember" tm
SET "organizationId" = t."organizationId"
FROM "Team" t
WHERE t."id" = tm."teamId";

UPDATE "WebsiteAssignment" wa
SET "organizationId" = w."organizationId"
FROM "Website" w
WHERE w."id" = wa."websiteId";

ALTER TABLE "TeamMember" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "WebsiteAssignment" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_id_organizationId_key" ON "User"("id", "organizationId");

-- CreateIndex
CREATE INDEX "TeamMember_organizationId_idx" ON "TeamMember"("organizationId");

-- CreateIndex
CREATE INDEX "WebsiteAssignment_organizationId_idx" ON "WebsiteAssignment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleProperty_id_connectionId_key" ON "GoogleProperty"("id", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleProperty_id_connectionId_key" ON "SearchConsoleProperty"("id", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSenseAccount_id_connectionId_key" ON "AdSenseAccount"("id", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "AdManagerNetwork_id_connectionId_key" ON "AdManagerNetwork"("id", "connectionId");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAssignment" ADD CONSTRAINT "WebsiteAssignment_websiteId_organizationId_fkey" FOREIGN KEY ("websiteId", "organizationId") REFERENCES "Website"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAssignment" ADD CONSTRAINT "WebsiteAssignment_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_googlePropertyId_googleConnectionId_fkey" FOREIGN KEY ("googlePropertyId", "googleConnectionId") REFERENCES "GoogleProperty"("id", "connectionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_searchConsolePropertyId_googleConnectio_fkey" FOREIGN KEY ("searchConsolePropertyId", "googleConnectionId") REFERENCES "SearchConsoleProperty"("id", "connectionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_adsenseAccountId_googleConnectionId_fkey" FOREIGN KEY ("adsenseAccountId", "googleConnectionId") REFERENCES "AdSenseAccount"("id", "connectionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_adManagerNetworkId_googleConnectionId_fkey" FOREIGN KEY ("adManagerNetworkId", "googleConnectionId") REFERENCES "AdManagerNetwork"("id", "connectionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- GoogleConnection (F-4.1): defensive re-backfill of typed owners from
-- the legacy polymorphic owner for any row still missing both, only
-- where the owner exists in the same organization (same rule as
-- Stage 2). Idempotent: rows already typed are untouched.
UPDATE "GoogleConnection" gc
SET "teamId" = gc."ownerId"
WHERE gc."ownerType" = 'TEAM'
  AND gc."teamId" IS NULL
  AND gc."websiteId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Team" t
    WHERE t."id" = gc."ownerId" AND t."organizationId" = gc."organizationId"
  );

UPDATE "GoogleConnection" gc
SET "websiteId" = gc."ownerId"
WHERE gc."ownerType" = 'WEBSITE'
  AND gc."teamId" IS NULL
  AND gc."websiteId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Website" w
    WHERE w."id" = gc."ownerId" AND w."organizationId" = gc."organizationId"
  );

-- Tighten the owner CHECK from "at most one" to "exactly one".
ALTER TABLE "GoogleConnection" DROP CONSTRAINT "GoogleConnection_single_owner_check";

ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_single_owner_check"
  CHECK (("teamId" IS NOT NULL) <> ("websiteId" IS NOT NULL));
