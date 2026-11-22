import { describe, expect, it } from "vitest";
import { aggregatePayloads } from "@/lib/portfolio";

// Phase 7.1 (DATA-6): portfolio aggregation math — sums are honest,
// rates are recomputed from summed totals, underivable metrics stay null.
describe("aggregatePayloads — GA4 overview", () => {
  it("sums additive metrics and recomputes rates", () => {
    const { totals, note } = aggregatePayloads("overview", [
      {
        summary: {
          activeUsers: 100,
          newUsers: 40,
          sessions: 120,
          screenPageViews: 300,
          engagedSessions: 90,
          eventCount: 500,
          keyEvents: 12,
          engagementRate: 0.75,
          bounceRate: 0.25,
          averageEngagementTime: 61,
          sessionConversionRate: 0.1,
        },
      },
      {
        summary: {
          activeUsers: 50,
          newUsers: 10,
          sessions: 80,
          screenPageViews: 200,
          engagedSessions: 40,
          eventCount: 300,
          keyEvents: 8,
          engagementRate: 0.5,
          bounceRate: 0.5,
          averageEngagementTime: 30,
          sessionConversionRate: 0.1,
        },
      },
    ]);
    expect(totals).toMatchObject({
      activeUsers: 150,
      sessions: 200,
      screenPageViews: 500,
      engagedSessions: 130,
      keyEvents: 20,
    });
    expect(totals?.engagementRate).toBeCloseTo(130 / 200);
    expect(totals?.bounceRate).toBeCloseTo(1 - 130 / 200);
    expect(totals?.sessionConversionRate).toBeCloseTo(20 / 200);
    expect(totals?.averageEngagementTime).toBeNull();
    expect(note).toContain("counts twice");
  });

  it("keeps all-null metrics null instead of inventing zero", () => {
    const { totals } = aggregatePayloads("overview", [{ summary: { sessions: null } }, { summary: {} }]);
    expect(totals?.sessions).toBeNull();
    expect(totals?.engagementRate).toBeNull();
  });
});

describe("aggregatePayloads — Search Console", () => {
  it("sums clicks/impressions, recomputes CTR, impression-weights position", () => {
    const { totals } = aggregatePayloads("search-console", [
      { totals: { clicks: 10, impressions: 100, avgCtr: 0.1, avgPosition: 5 } },
      { totals: { clicks: 30, impressions: 300, avgCtr: 0.1, avgPosition: 9 } },
    ]);
    expect(totals?.clicks).toBe(40);
    expect(totals?.impressions).toBe(400);
    expect(totals?.avgCtr).toBeCloseTo(0.1);
    expect(totals?.avgPosition).toBeCloseTo((5 * 100 + 9 * 300) / 400);
  });
});

describe("aggregatePayloads — AdSense", () => {
  it("sums string totals and recomputes rates", () => {
    const { totals } = aggregatePayloads("adsense", [
      { totalsByMetric: { ESTIMATED_EARNINGS: "10.50", PAGE_VIEWS: "1000", IMPRESSIONS: "2000", CLICKS: "20" } },
      { totalsByMetric: { ESTIMATED_EARNINGS: "5.25", PAGE_VIEWS: "500", IMPRESSIONS: "1000", CLICKS: "10" } },
    ]);
    expect(totals?.ESTIMATED_EARNINGS).toBeCloseTo(15.75);
    expect(totals?.CLICKS).toBe(30);
    expect(totals?.CTR).toBeCloseTo(30 / 3000);
    expect(totals?.CPC).toBeCloseTo(15.75 / 30);
    expect(totals?.PAGE_RPM).toBeCloseTo((15.75 / 1500) * 1000);
  });
});

describe("aggregatePayloads — unsupported reports", () => {
  it("returns null totals with an explicit note", () => {
    const { totals, note } = aggregatePayloads("realtime", [{ activeUsers: 3 }]);
    expect(totals).toBeNull();
    expect(note).toBe("aggregation_not_supported_for_report");
  });
});
