import { describe, it, expect } from "vitest";
import { buildCacheKey } from "@/lib/cache";
describe("cache keys (tenant isolation)", () => {
  it("includes org, website, property, source, report, range", () => {
    const k = buildCacheKey({ organizationId: "org1", websiteId: "w1", propertyId: "p1", source: "ga4", report: "overview", range: "2026-11-01_2026-11-28" });
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
});
