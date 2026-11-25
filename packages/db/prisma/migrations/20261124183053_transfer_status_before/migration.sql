-- A-DB-04: record the website status at transfer initiation so
-- `complete` can restore it instead of hard-coding ACTIVE.
-- Nullable: transfers initiated before this migration have no
-- recorded status and fall back to ACTIVE at completion.
-- AlterTable
ALTER TABLE "WebsiteTransfer" ADD COLUMN     "websiteStatusBefore" "WebsiteStatus";
