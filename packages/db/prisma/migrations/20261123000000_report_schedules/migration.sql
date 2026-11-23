-- Phase 7.3: scheduled email reports.
-- Adds the SCHEDULED_REPORT sync-job type (bookkeeping for report
-- jobs) and the ReportSchedule table (one schedule per organization).
-- The new enum value is not used by any DML in this migration, so it
-- is safe to add in the same transaction.
ALTER TYPE "SyncJobType" ADD VALUE 'SCHEDULED_REPORT';

CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dayOfWeek" INTEGER NOT NULL DEFAULT 1,
    "hourUtc" INTEGER NOT NULL DEFAULT 8,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportSchedule_organizationId_key" ON "ReportSchedule"("organizationId");

ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
