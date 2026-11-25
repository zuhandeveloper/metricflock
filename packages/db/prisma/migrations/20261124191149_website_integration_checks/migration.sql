-- A-DB-07: `WebsiteIntegration` has no DB rule tying the property FK to
-- its provider (docs/audit/03-DATABASE-AUDIT.md). The map route
-- (`apps/web/src/app/api/google/properties/map/route.ts`) is the first line
-- of defence; these CHECKs are the database backstop.
--
-- Prisma's schema DSL cannot express CHECK constraints (Prisma 7.10 has no
-- `@@check`), so they live here only — the same pattern as
-- `GoogleConnection_single_owner_check` in the Stage 2 / Phase 4
-- migrations. `prisma migrate diff` emits nothing for this migration (the
-- schema is unchanged); the three ALTERs below are hand-written.
--
-- RISK — READ BEFORE DEPLOY: `ALTER TABLE ... ADD CONSTRAINT` validates
-- every existing row. Stage 2 (DB-7) deliberately left ambiguous or
-- undiscovered mappings with `googleConnectionId IS NULL` and no property
-- FK, and any such row — or any other row violating the rules below —
-- makes `prisma migrate deploy` FAIL on that database. Do NOT deploy this
-- migration to production until the target DB has been checked and any
-- violating rows repaired (re-mapped or deleted). Pre-flight query (run
-- against the target DB; it must return zero rows):
--
--   SELECT "id", "provider", "mappingStatus", "isPrimary",
--          "googleConnectionId", "googlePropertyId",
--          "searchConsolePropertyId", "adsenseAccountId", "adManagerNetworkId"
--   FROM "WebsiteIntegration"
--   WHERE NOT (
--     ("provider" = 'GA4' AND "googlePropertyId" IS NOT NULL
--       AND "searchConsolePropertyId" IS NULL AND "adsenseAccountId" IS NULL
--       AND "adManagerNetworkId" IS NULL)
--     OR ("provider" = 'SEARCH_CONSOLE' AND "searchConsolePropertyId" IS NOT NULL
--       AND "googlePropertyId" IS NULL AND "adsenseAccountId" IS NULL
--       AND "adManagerNetworkId" IS NULL)
--     OR ("provider" = 'ADSENSE' AND "adsenseAccountId" IS NOT NULL
--       AND "googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL
--       AND "adManagerNetworkId" IS NULL)
--     OR ("provider" = 'AD_MANAGER' AND "adManagerNetworkId" IS NOT NULL
--       AND "googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL
--       AND "adsenseAccountId" IS NULL)
--   )
--   OR NOT (
--     ("googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL
--       AND "adsenseAccountId" IS NULL AND "adManagerNetworkId" IS NULL)
--     OR "googleConnectionId" IS NOT NULL
--   )
--   OR ("isPrimary" AND "mappingStatus" <> 'MAPPED');

-- Exactly one property FK set, and it must be the provider's own:
-- GA4 <-> googlePropertyId, SEARCH_CONSOLE <-> searchConsolePropertyId,
-- ADSENSE <-> adsenseAccountId, AD_MANAGER <-> adManagerNetworkId.
-- (The rule is status-independent: a PENDING row, if one is ever created,
-- must still carry its provider's FK. No code path creates FK-less rows.)
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_provider_fk_check"
  CHECK (
    ("provider" = 'GA4' AND "googlePropertyId" IS NOT NULL AND "searchConsolePropertyId" IS NULL AND "adsenseAccountId" IS NULL AND "adManagerNetworkId" IS NULL)
    OR ("provider" = 'SEARCH_CONSOLE' AND "searchConsolePropertyId" IS NOT NULL AND "googlePropertyId" IS NULL AND "adsenseAccountId" IS NULL AND "adManagerNetworkId" IS NULL)
    OR ("provider" = 'ADSENSE' AND "adsenseAccountId" IS NOT NULL AND "googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL AND "adManagerNetworkId" IS NULL)
    OR ("provider" = 'AD_MANAGER' AND "adManagerNetworkId" IS NOT NULL AND "googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL AND "adsenseAccountId" IS NULL)
  );

-- A property FK is meaningless without its connection. (Postgres MATCH
-- SIMPLE does not enforce the composite FKs when googleConnectionId is
-- NULL, so this CHECK is what closes that hole.)
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_connection_required_check"
  CHECK (
    ("googlePropertyId" IS NULL AND "searchConsolePropertyId" IS NULL AND "adsenseAccountId" IS NULL AND "adManagerNetworkId" IS NULL)
    OR "googleConnectionId" IS NOT NULL
  );

-- A primary mapping must be a live mapping.
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_primary_mapped_check"
  CHECK (NOT "isPrimary" OR "mappingStatus" = 'MAPPED');
