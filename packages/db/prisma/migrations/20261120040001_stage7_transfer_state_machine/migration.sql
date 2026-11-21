-- AlterTable
ALTER TABLE "WebsiteTransfer" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedById" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "WebsiteTransfer" ADD CONSTRAINT "WebsiteTransfer_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Stage 7 (API-4/DB-4): at most ONE open transfer per website. Prisma
-- cannot express partial unique indexes, so this is raw SQL.
CREATE UNIQUE INDEX "WebsiteTransfer_one_open_per_website"
  ON "WebsiteTransfer" ("websiteId")
  WHERE "status" IN ('INITIATED', 'PENDING_ACCEPTANCE', 'PENDING_CONNECTION');

-- Backfill (audit §8): the old instant-transfer flow already moved teamId
-- and marked rows TRANSFERRED, leaving websites stuck in TRANSFER_PENDING.
-- Those transfers are effectively done: close them out and free the sites.
UPDATE "WebsiteTransfer"
  SET "status" = 'COMPLETED', "completedAt" = COALESCE("completedAt", "updatedAt")
  WHERE "status" = 'TRANSFERRED';
UPDATE "Website" w
  SET "status" = 'ACTIVE'
  WHERE w."status" = 'TRANSFER_PENDING'
    AND NOT EXISTS (
      SELECT 1 FROM "WebsiteTransfer" t
      WHERE t."websiteId" = w."id"
        AND t."status" IN ('INITIATED', 'PENDING_ACCEPTANCE', 'PENDING_CONNECTION')
    );
