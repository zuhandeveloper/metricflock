-- A-SEC-09: API key expiry and scopes. `expiresAt` is null for
-- legacy keys (never expires); `scopes` is empty for legacy keys
-- (full v1 access). Both columns are nullable/empty by default so
-- existing keys keep working unchanged.
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
