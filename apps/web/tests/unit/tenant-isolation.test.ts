import { describe, it, expect } from "vitest";
import { buildCacheKey } from "@metricflock/shared";
import { hasPermission } from "@metricflock/auth";
// Pure, DB-free tenant-isolation checks. Full cross-org/cross-team isolation
// is covered by the DB-backed security section of scripts/smoke-test.sh,
// which runs in CI against real Postgres + Redis.
describe("tenant isolation (unit-level)", () => {
  it("cache keys are org-scoped so no cross-tenant leak via cache", () => {
    const k1 = buildCacheKey({
      organizationId: "org-a",
      websiteId: "w",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    const k2 = buildCacheKey({
      organizationId: "org-b",
      websiteId: "w",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    expect(k1).not.toBe(k2);
  });
  it("team members lack cross-team management permissions", () => {
    expect(hasPermission("TEAM_MEMBER", "team.manage")).toBe(false);
    expect(hasPermission("TEAM_MEMBER", "website.assign")).toBe(false);
    expect(hasPermission("TEAM_MEMBER", "google.connection.manage")).toBe(false);
  });
  it("team admins lack super-admin-only permissions", () => {
    expect(hasPermission("TEAM_ADMIN", "organization.manage")).toBe(false);
    expect(hasPermission("TEAM_ADMIN", "audit.view")).toBe(false);
    // A-API-12: `website.transfer` is NOT super-admin-only anymore —
    // TEAM_ADMIN holds it (permissions.test.ts pins the grant).
  });
});
