import { describe, expect, it, vi, beforeEach } from "vitest";
import { aggregatePayloads, loadPortfolio } from "@/lib/portfolio";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  readSnapshots: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  getPrimaryIntegrations: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { website: { count: mocks.count, findMany: mocks.findMany } },
}));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: mocks.readSnapshots }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: mocks.getPrimaryIntegrations }));

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

  it("leaves RPM null when earnings are missing instead of inventing 0 (A-GGL-05)", () => {
    const { totals } = aggregatePayloads("adsense", [
      { totalsByMetric: { ESTIMATED_EARNINGS: null, PAGE_VIEWS: "1500", IMPRESSIONS: "3000", CLICKS: "10" } },
      { totalsByMetric: { PAGE_VIEWS: "500", IMPRESSIONS: "1000", CLICKS: "5" } },
    ]);
    expect(totals?.ESTIMATED_EARNINGS).toBeNull();
    expect(totals?.PAGE_RPM).toBeNull();
    expect(totals?.IMPRESSION_RPM).toBeNull();
    // Consistent with the neighbouring rates, which already yielded null.
    expect(totals?.CPC).toBeNull();
    expect(totals?.CTR).toBeCloseTo(15 / 4000);
  });

  it("keeps a genuine zero-earnings RPM at 0 and null page views at null RPM", () => {
    const zero = aggregatePayloads("adsense", [
      { totalsByMetric: { ESTIMATED_EARNINGS: "0", PAGE_VIEWS: "1500", IMPRESSIONS: "3000", CLICKS: "10" } },
    ]);
    expect(zero.totals?.PAGE_RPM).toBe(0);
    expect(zero.totals?.IMPRESSION_RPM).toBe(0);

    const noViews = aggregatePayloads("adsense", [
      { totalsByMetric: { ESTIMATED_EARNINGS: "10.50", PAGE_VIEWS: null, IMPRESSIONS: "3000", CLICKS: "10" } },
    ]);
    expect(noViews.totals?.PAGE_RPM).toBeNull();
    expect(noViews.totals?.IMPRESSION_RPM).toBeCloseTo((10.5 / 3000) * 1000);
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
    // A-DB-11: one batched primaries map (w3 has no mapping) and one
    // batched snapshots map (only w1 has a snapshot).
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map();
      for (const id of websiteIds) {
        if (id === "w3") continue;
        out.set(id, new Map(providers.map((p) => [p, { externalId: `properties/${id}` }])));
      }
      return out;
    });
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map();
      for (const key of keys) {
        if (!key.includes("w1")) continue;
        out.set(key, {
          payload: { summary: { sessions: 42, engagedSessions: 21, keyEvents: 2 } },
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date("2026-11-22T00:00:00Z"),
        });
      }
      return out;
    });
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
    // A-DB-11: the batch equivalents of the old per-website failures —
    // w1 is missing from the primaries map, the snapshots batch rejects.
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map();
      for (const id of websiteIds) {
        if (id === "w1") continue;
        out.set(id, new Map(providers.map((p) => [p, { externalId: `properties/${id}` }])));
      }
      return out;
    });
    mocks.readSnapshots.mockRejectedValue(new Error("cache down"));
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

  it("issues one batched primaries query and one batched snapshot query (A-DB-11)", async () => {
    await loadPortfolio(user, opts);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledWith(["w1", "w2", "w3"], ["GA4"]);
    expect(mocks.readSnapshots).toHaveBeenCalledTimes(1);
    const keys = mocks.readSnapshots.mock.calls[0]![0] as string[];
    expect(keys).toHaveLength(2); // w1 + w2 (w3 has no mapping)
    expect(keys.every((k) => k.startsWith("analytics:org1:"))).toBe(true);
  });

  it("clamps the Search Console range when building snapshot keys (A-GGL-07)", async () => {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const start = fmt(new Date(today.getTime() - 27 * 86400000));
    const maxEnd = fmt(new Date(today.getTime() - 3 * 86400000));
    await loadPortfolio(user, {
      provider: "SEARCH_CONSOLE",
      source: "search-console",
      report: "search-console",
      startDate: start,
      endDate: fmt(today),
    });
    const keys = mocks.readSnapshots.mock.calls[0]![0] as string[];
    expect(keys).toHaveLength(2);
    // The key is what the worker warms — endDate 3 days ago, not today.
    expect(keys.every((k) => k.includes(`:${start}_${maxEnd}:`))).toBe(true);
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
