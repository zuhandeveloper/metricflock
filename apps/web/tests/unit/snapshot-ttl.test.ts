import { describe, it, expect } from "vitest";
import { snapshotTtlSeconds } from "@metricflock/jobs";

// Phase 5 (F-5.4 hybrid): snapshot freshness = max(Redis cache TTL,
// the report's scheduled sync interval) so a snapshot stays servable
// until the next sync would refresh it anyway.
describe("snapshotTtlSeconds", () => {
  it("uses the sync interval when it exceeds the cache TTL", () => {
    // GA4 historical syncs every 45 min; route cache TTL is 300s.
    expect(snapshotTtlSeconds("overview", 300)).toBe(2700);
    expect(snapshotTtlSeconds("traffic", 300)).toBe(2700);
    // Search Console syncs every 8h; route cache TTL is 3600s.
    expect(snapshotTtlSeconds("search-console", 3600)).toBe(28_800);
    // AdSense / Ad Manager sync every 3h.
    expect(snapshotTtlSeconds("adsense", 3600)).toBe(10_800);
    expect(snapshotTtlSeconds("ad-manager", 3600)).toBe(10_800);
  });
  it("uses the cache TTL when it exceeds the sync interval", () => {
    // Realtime syncs every 300s; a hypothetical longer cache TTL wins.
    expect(snapshotTtlSeconds("realtime", 900)).toBe(900);
    expect(snapshotTtlSeconds("realtime", 30)).toBe(300);
  });
  it("falls back to the cache TTL for unknown reports", () => {
    expect(snapshotTtlSeconds("no-such-report", 123)).toBe(123);
  });
});
