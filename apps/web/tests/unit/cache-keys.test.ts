import { describe, it, expect } from "vitest";
import { buildCacheKey } from "@metricflock/shared";
describe("cache keys (tenant isolation)", () => {
  it("includes org, website, property, source, report, range", () => {
    const k = buildCacheKey({
      organizationId: "org1",
      websiteId: "w1",
      propertyId: "p1",
      source: "ga4",
      report: "overview",
      range: "2026-11-01_2026-11-28",
    });
    expect(k).toBe("analytics:org1:w1:p1:ga4:overview:2026-11-01_2026-11-28:all");
  });
  it("different orgs never share a key", () => {
    const a = buildCacheKey({ organizationId: "org1", websiteId: "w1", source: "ga4", report: "overview", range: "x" });
    const b = buildCacheKey({ organizationId: "org2", websiteId: "w1", source: "ga4", report: "overview", range: "x" });
    expect(a).not.toBe(b);
  });
  it("different filters never share a key", () => {
    const a = buildCacheKey({ organizationId: "o", source: "ga4", report: "pages", range: "x", filters: "a" });
    const b = buildCacheKey({ organizationId: "o", source: "ga4", report: "pages", range: "x", filters: "b" });
    expect(a).not.toBe(b);
  });

  // A-COV-11: pin the segment defaults and per-segment uniqueness —
  // the org:website prefix order is load-bearing (invalidateWebsiteCache
  // / invalidateOrgCache SCAN by that exact prefix).
  it("defaults website to org, property to none, filters to all", () => {
    expect(buildCacheKey({ organizationId: "o1", source: "ga4", report: "overview", range: "x" })).toBe(
      "analytics:o1:org:none:ga4:overview:x:all",
    );
  });
  it("explicit 'all' filters produce the same key as omitted filters", () => {
    const a = buildCacheKey({ organizationId: "o", source: "ga4", report: "pages", range: "x" });
    const b = buildCacheKey({ organizationId: "o", source: "ga4", report: "pages", range: "x", filters: "all" });
    expect(a).toBe(b);
  });
  it("every segment participates in uniqueness", () => {
    const base = {
      organizationId: "o",
      websiteId: "w",
      propertyId: "p",
      source: "ga4",
      report: "overview",
      range: "x",
    };
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, websiteId: "w2" })).not.toBe(key);
    expect(buildCacheKey({ ...base, propertyId: "p2" })).not.toBe(key);
    expect(buildCacheKey({ ...base, source: "adsense" })).not.toBe(key);
    expect(buildCacheKey({ ...base, report: "pages" })).not.toBe(key);
    expect(buildCacheKey({ ...base, range: "y" })).not.toBe(key);
  });
  it("org and website occupy the prefix segments the invalidation SCANs rely on", () => {
    const k = buildCacheKey({ organizationId: "org1", websiteId: "w1", source: "ga4", report: "overview", range: "x" });
    expect(k.startsWith("analytics:org1:w1:")).toBe(true);
    expect(k.startsWith("analytics:org1:")).toBe(true);
  });
});
