-- Stage 7 (API-4/DB-4): two-sided transfer acceptance needs two new
-- states. Enum values are added in their own migration: PostgreSQL does
-- not allow USING a new enum value in the same transaction that adds it,
-- and the follow-up migration's index/backfill reference these values.
ALTER TYPE "TransferStatus" ADD VALUE 'PENDING_ACCEPTANCE';
ALTER TYPE "TransferStatus" ADD VALUE 'EXPIRED';
