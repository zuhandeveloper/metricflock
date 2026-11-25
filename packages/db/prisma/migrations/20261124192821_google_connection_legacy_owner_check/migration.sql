-- A-DB-08: `GoogleConnection` legacy polymorphic owner columns can drift
-- from the typed owner FKs (docs/audit/03-DATABASE-AUDIT.md). The OAuth
-- callback and the smoke fixtures write legacy + typed in sync, but
-- nothing in the database tied them together: a direct UPDATE could move
-- `teamId`/`websiteId` while `ownerType`/`ownerId` still named the old
-- owner, and `assertConnectionScopeForWebsite` then fell back to the
-- legacy columns whenever the typed column was NULL — so the same
-- connection could be authorised differently depending on which column
-- a caller read.
--
-- Prisma's schema DSL cannot express CHECK constraints (Prisma 7.10 has no
-- `@@check`), so this CHECK lives here only — the same pattern as
-- `GoogleConnection_single_owner_check` in the Stage 2 / Phase 4
-- migrations and the A-DB-07 CHECKs. `prisma migrate diff` emits nothing
-- for this migration (the schema is unchanged apart from a comment).
-- The scope function (`packages/auth/src/tenant.ts`) no longer consults
-- the legacy columns at all; with this CHECK they cannot disagree with
-- the typed FKs.
--
-- RISK — READ BEFORE DEPLOY: `ALTER TABLE ... ADD CONSTRAINT` validates
-- every existing row. Every connection written by the app (OAuth callback)
-- or the fixtures writes legacy + typed in sync, so a healthy database
-- should have zero violating rows — but any row that drifted (e.g. via a
-- direct UPDATE, the audit's reproduction) makes `prisma migrate deploy`
-- FAIL on that database. Do NOT deploy this migration to production
-- until the target DB has been checked and any violating rows repaired
-- (re-write the typed FKs from the legacy columns, or delete the row).
-- Pre-flight query (run against the target DB; it must return zero rows):
--
--   SELECT "id", "ownerType", "ownerId", "teamId", "websiteId"
--   FROM "GoogleConnection"
--   WHERE NOT (
--     ("ownerType" = 'TEAM' AND "teamId" = "ownerId" AND "websiteId" IS NULL)
--     OR ("ownerType" = 'WEBSITE' AND "websiteId" = "ownerId" AND "teamId" IS NULL)
--   );
--
-- The legacy columns are NOT dropped by this migration. Dropping them is
-- blocked for now: the token-encryption AAD (`connectionAad`) is derived
-- from `ownerType`/`ownerId`, `revokeConnectionToken` and the refresh path
-- decrypt with the AAD built from the stored row, and the
-- `@@unique([organizationId, ownerType, ownerId, googleAccountEmail])`
-- is the OAuth callback's upsert key. The drop is a future cleanup once
-- the AAD is derived from the typed FKs and the upsert key is re-keyed.

-- Legacy owner must name exactly the typed owner, and the other typed
-- FK must be NULL (mirrors the exactly-one rule in
-- `GoogleConnection_single_owner_check`).
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_legacy_owner_match_check"
  CHECK (
    ("ownerType" = 'TEAM' AND "teamId" = "ownerId" AND "websiteId" IS NULL)
    OR ("ownerType" = 'WEBSITE' AND "websiteId" = "ownerId" AND "teamId" IS NULL)
  );
