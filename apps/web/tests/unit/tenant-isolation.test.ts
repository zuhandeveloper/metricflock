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

  // A-COV-11: isolation also holds one level down — two websites (or
  // two properties) inside the SAME org must never share a cache key,
  // and an org-level key must not collide with a website-level one.
  it("cache keys are website-scoped within an org", () => {
    const a = buildCacheKey({
      organizationId: "org-a",
      websiteId: "w1",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    const b = buildCacheKey({
      organizationId: "org-a",
      websiteId: "w2",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    expect(a).not.toBe(b);
  });
  it("cache keys are property-scoped within a website", () => {
    const a = buildCacheKey({
      organizationId: "org-a",
      websiteId: "w1",
      propertyId: "p1",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    const b = buildCacheKey({
      organizationId: "org-a",
      websiteId: "w1",
      propertyId: "p2",
      source: "ga4",
      report: "overview",
      range: "r",
    });
    expect(a).not.toBe(b);
  });
  it("the org-level key uses the 'org' sentinel segment", () => {
    // Website ids are cuids, so the literal "org" sentinel can never
    // collide with a real website segment.
    const orgLevel = buildCacheKey({ organizationId: "org-a", source: "ga4", report: "overview", range: "r" });
    expect(orgLevel).toBe("analytics:org-a:org:none:ga4:overview:r:all");
  });
});
