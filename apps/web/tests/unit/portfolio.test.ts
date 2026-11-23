import { describe, expect, it, vi, beforeEach } from "vitest";
import { aggregatePayloads, loadPortfolio } from "@/lib/portfolio";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  readSnapshot: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  getPrimaryIntegration: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { website: { count: mocks.count, findMany: mocks.findMany } },
}));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshot: mocks.readSnapshot }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegration: mocks.getPrimaryIntegration }));

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

describe("loadPortfolio", () => {
  const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };
  const opts = {
    provider: "GA4" as const,
    source: "ga4",
    report: "overview",
    startDate: "2026-10-26",
    endDate: "2026-11-22",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.count.mockResolvedValue(3);
    mocks.findMany.mockResolvedValue([
      { id: "w1", name: "Site One", domain: "one.example" },
      { id: "w2", name: "Site Two", domain: "two.example" },
      { id: "w3", name: "Site Three", domain: "three.example" },
    ]);
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string) =>
      websiteId === "w3" ? null : { externalId: `properties/${websiteId}` },
    );
    mocks.readSnapshot.mockImplementation(async (key: string) =>
      key.includes("w1")
        ? {
            payload: { summary: { sessions: 42, engagedSessions: 21, keyEvents: 2 } },
            expiresAt: new Date(Date.now() + 60_000),
            updatedAt: new Date("2026-11-22T00:00:00Z"),
          }
        : null,
    );
  });

  it("includes snapshotted websites and reports the rest unavailable with reasons", async () => {
    const result = await loadPortfolio(user, opts);
    expect(result.websites).toHaveLength(1);
    expect(result.websites[0]).toMatchObject({ websiteId: "w1", name: "Site One", stale: false });
    expect(result.totals?.sessions).toBe(42);
    expect(result.unavailableWebsites).toEqual(
      expect.arrayContaining([
        { websiteId: "w2", reason: "no_snapshot_yet" },
        { websiteId: "w3", reason: "no_property_mapped" },
      ]),
    );
    expect(result.websiteCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("treats integration/snapshot lookup failures as unavailable, not fatal", async () => {
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string) => {
      if (websiteId === "w1") throw new Error("db down");
      return { externalId: `properties/${websiteId}` };
    });
    mocks.readSnapshot.mockRejectedValue(new Error("cache down"));
    const result = await loadPortfolio(user, opts);
    expect(result.websites).toHaveLength(0);
    expect(result.unavailableWebsites).toEqual(
      expect.arrayContaining([
        { websiteId: "w1", reason: "no_property_mapped" },
        { websiteId: "w2", reason: "no_snapshot_yet" },
        { websiteId: "w3", reason: "no_snapshot_yet" },
      ]),
    );
  });

  it("scopes the query to accessible websites for restricted users", async () => {
    mocks.listAccessibleWebsiteIds.mockResolvedValue(["w1"]);
    mocks.count.mockResolvedValue(1);
    mocks.findMany.mockResolvedValue([{ id: "w1", name: "Site One", domain: "one.example" }]);
    await loadPortfolio({ ...user, role: "TEAM_MEMBER" }, opts);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org1", id: { in: ["w1"] } } }),
    );
  });

  it("flags truncation when more websites exist than the limit returns", async () => {
    mocks.count.mockResolvedValue(500);
    const result = await loadPortfolio(user, { ...opts, limit: 2 });
    expect(result.truncated).toBe(true);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });
});
