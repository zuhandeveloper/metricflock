import { describe, expect, it, vi, beforeEach } from "vitest";

// A-DB-11 regression test: a 50-website org's insights/portfolio loads
// must issue a constant number of Prisma round-trips, not O(N). The
// mocked modules expose ONLY the batch helpers — if a loader regressed
// to the per-website getPrimaryIntegration/readSnapshot calls it would
// throw (not a function), so the call counts below are a real guard.
const mocks = vi.hoisted(() => ({
  websiteCount: vi.fn(),
  websiteFindMany: vi.fn(),
  readSnapshots: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  getPrimaryIntegrations: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { website: { count: mocks.websiteCount, findMany: mocks.websiteFindMany } },
}));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: mocks.readSnapshots }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: mocks.getPrimaryIntegrations }));

import { loadInsights } from "@/lib/insights";
import { loadPortfolio } from "@/lib/portfolio";

const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };
const SITES = Array.from({ length: 50 }, (_, i) => ({
  id: `w${i}`,
  name: `Site ${String(i).padStart(2, "0")}`,
  domain: `site${i}.example`,
}));

const snapshot = (payload: unknown) => ({
  payload,
  expiresAt: new Date(Date.now() + 60_000),
  updatedAt: new Date("2026-11-22T00:00:00Z"),
});

function payloadForKey(key: string): unknown | null {
  if (key.includes("search-console"))
    return {
      totals: { clicks: 10, impressions: 1000, avgCtr: 0.01, avgPosition: 7 },
      rows: [{ keys: ["2026-11-01", "best widgets", "/w"], clicks: 10, impressions: 1000, position: 7 }],
    };
  if (key.includes("adsense"))
    return {
      totalsByMetric: { ESTIMATED_EARNINGS: "50", PAGE_VIEWS: "4000", IMPRESSIONS: "4000", CLICKS: "0" },
      rows: [{ DATE: "2026-11-01", ESTIMATED_EARNINGS: 50 }],
    };
  if (key.includes("traffic")) return { rows: [{ dimension0: "Organic Search", sessions: 100 }] };
  if (key.includes("overview"))
    return {
      summary: {
        sessions: 1000,
        engagedSessions: 500,
        keyEvents: 10,
        activeUsers: 800,
        newUsers: 100,
        screenPageViews: 2000,
        eventCount: 3000,
      },
    };
  return null;
}

describe("A-DB-11 — loader query counts stay O(1) with website count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.websiteCount.mockResolvedValue(50);
    mocks.websiteFindMany.mockResolvedValue(SITES);
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map();
      for (const id of websiteIds) {
        out.set(id, new Map(providers.map((p) => [p, { externalId: `properties/${id}` }])));
      }
      return out;
    });
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map();
      for (const key of keys) {
        const payload = payloadForKey(key);
        if (payload) out.set(key, snapshot(payload));
      }
      return out;
    });
  });

  it("loadInsights for 50 websites issues 4 Prisma-issuing calls, not ~500", async () => {
    const out = await loadInsights(user);
    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledWith(
      SITES.map((s) => s.id),
      ["GA4", "SEARCH_CONSOLE", "ADSENSE"],
    );
    expect(mocks.readSnapshots).toHaveBeenCalledTimes(1);
    // 3 insight reports × 50 sites + GA4 overview × 50 sites, with the
    // AdSense insight/portfolio key shared (200 distinct keys, not 250).
    expect((mocks.readSnapshots.mock.calls[0]![0] as string[]).length).toBe(200);
    expect(mocks.listAccessibleWebsiteIds).toHaveBeenCalledTimes(1);
    // And the batched data actually flows through: totals are the sums
    // over all 50 sites, not an empty result.
    expect(out.websites).toHaveLength(50);
    expect(out.unavailableCount).toBe(0);
    expect(out.summary.totalEarnings).toBe(2500);
    expect(out.summary.blendedPageRpm).toBeCloseTo(12.5);
    expect(out.summary.earningsPerThousandSessions).toBe(50);
  });

  it("loadPortfolio for 50 websites issues 4 Prisma-issuing calls, not ~100", async () => {
    const out = await loadPortfolio(user, {
      provider: "GA4",
      source: "ga4",
      report: "overview",
      startDate: "2026-10-26",
      endDate: "2026-11-22",
    });
    expect(mocks.websiteCount).toHaveBeenCalledTimes(1);
    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledWith(
      SITES.map((s) => s.id),
      ["GA4"],
    );
    expect(mocks.readSnapshots).toHaveBeenCalledTimes(1);
    expect((mocks.readSnapshots.mock.calls[0]![0] as string[]).length).toBe(50);
    expect(out.websites).toHaveLength(50);
    expect(out.totals?.sessions).toBe(50000);
  });
});
