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

  // A-COV-11: every report in SYNC_TYPE_BY_REPORT resolves to its
  // queue's interval, and degenerate cache TTLs never shorten the
  // freshness window below the sync interval.
  it("resolves the remaining GA4 historical reports to the 45-minute interval", () => {
    expect(snapshotTtlSeconds("audience", 300)).toBe(2700);
    expect(snapshotTtlSeconds("pages", 300)).toBe(2700);
    expect(snapshotTtlSeconds("events", 300)).toBe(2700);
  });
  it("never lets a zero or negative cache TTL shorten the window", () => {
    expect(snapshotTtlSeconds("overview", 0)).toBe(2700);
    expect(snapshotTtlSeconds("overview", -60)).toBe(2700);
    expect(snapshotTtlSeconds("realtime", 0)).toBe(300);
  });
  it("returns the shared value when cache TTL equals the sync interval", () => {
    expect(snapshotTtlSeconds("overview", 2700)).toBe(2700);
    expect(snapshotTtlSeconds("search-console", 28_800)).toBe(28_800);
  });
  it("returns a zero cache TTL unchanged for unknown reports", () => {
    expect(snapshotTtlSeconds("no-such-report", 0)).toBe(0);
  });
});
