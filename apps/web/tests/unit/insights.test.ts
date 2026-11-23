import { describe, expect, it } from "vitest";
import { seoInsights, revenueInsights, channelMix } from "@metricflock/shared";

describe("seoInsights (Phase 7.4)", () => {
  const payload = {
    totals: { clicks: 130, impressions: 2000, avgCtr: 0.065, avgPosition: 8 },
    truncated: false,
    rows: [
      // "best widgets" — striking distance (position ~7), high impressions
      { keys: ["2026-11-01", "best widgets", "/widgets"], clicks: 10, impressions: 500, ctr: 0.02, position: 7 },
      { keys: ["2026-11-02", "best widgets", "/widgets"], clicks: 14, impressions: 500, ctr: 0.028, position: 7 },
      // "widget guide" — top query, position 2
      { keys: ["2026-11-01", "widget guide", "/guide"], clicks: 90, impressions: 600, ctr: 0.15, position: 2 },
      // "tiny query" — too few impressions for striking distance
      { keys: ["2026-11-01", "tiny query", "/tiny"], clicks: 1, impressions: 5, ctr: 0.2, position: 9 },
    ],
  };

  it("aggregates rows by query with impression-weighted position and recomputed CTR", () => {
    const out = seoInsights(payload);
    expect(out.queryCount).toBe(3);
    const top = out.topQueries[0]!;
    expect(top.query).toBe("widget guide");
    expect(top.clicks).toBe(90);
    const best = out.topQueries.find((q) => q.query === "best widgets")!;
    expect(best.impressions).toBe(1000);
    expect(best.ctr).toBeCloseTo(24 / 1000);
    expect(best.position).toBeCloseTo(7);
  });

  it("finds striking-distance and low-CTR opportunities with honest thresholds", () => {
    const out = seoInsights(payload);
    expect(out.strikingDistance.map((q) => q.query)).toEqual(["best widgets"]);
    expect(out.lowCtr.map((q) => q.query)).toEqual(["best widgets"]); // CTR 2.4% < site 6.5%
  });

  it("returns empty insights for a missing payload", () => {
    const out = seoInsights(null);
    expect(out.queryCount).toBe(0);
    expect(out.strikingDistance).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});

describe("revenueInsights (Phase 7.4)", () => {
  it("computes daily stats and a first-half vs second-half trend", () => {
    const out = revenueInsights({
      totalsByMetric: { ESTIMATED_EARNINGS: "70" },
      rows: [
        { DATE: "2026-11-01", ESTIMATED_EARNINGS: 10 },
        { DATE: "2026-11-02", ESTIMATED_EARNINGS: 10 },
        { DATE: "2026-11-03", ESTIMATED_EARNINGS: 20 },
        { DATE: "2026-11-04", ESTIMATED_EARNINGS: 30 },
      ],
    });
    expect(out.totalEarnings).toBe(70);
    expect(out.daysWithData).toBe(4);
    expect(out.avgDailyEarnings).toBeCloseTo(17.5);
    expect(out.bestDay).toEqual({ date: "2026-11-04", earnings: 30 });
    expect(out.trendPercent).toBeCloseTo(150); // 10 -> 25 avg
  });

  it("handles missing payloads without inventing numbers", () => {
    const out = revenueInsights(undefined);
    expect(out.totalEarnings).toBeNull();
    expect(out.trendPercent).toBeNull();
  });
});

describe("channelMix (Phase 7.4)", () => {
  it("aggregates sessions by channel with shares", () => {
    const out = channelMix({
      rows: [
        { dimension0: "Organic Search", sessions: 60 },
        { dimension0: "Organic Search", sessions: 20 },
        { dimension0: "Direct", sessions: 20 },
      ],
    });
    expect(out).toEqual([
      { channel: "Organic Search", sessions: 80, sharePercent: 80 },
      { channel: "Direct", sessions: 20, sharePercent: 20 },
    ]);
  });
});
