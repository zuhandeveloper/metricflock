import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  readSnapshot: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  getPrimaryIntegration: vi.fn(),
  loadPortfolio: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({ prisma: { website: { findMany: mocks.findMany } } }));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshot: mocks.readSnapshot }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegration: mocks.getPrimaryIntegration }));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));

import { loadInsights } from "@/lib/insights";

const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };

describe("loadInsights (Phase 7.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([
      { id: "w1", name: "Site One", domain: "one.example" },
      { id: "w2", name: "Site Two", domain: "two.example" },
    ]);
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string) => ({
      externalId: `properties/${websiteId}`,
    }));
    mocks.readSnapshot.mockImplementation(async (key: string) => {
      if (key.includes("w2")) return null; // Site Two has no snapshots yet
      if (key.includes("search-console"))
        return {
          payload: {
            totals: { clicks: 10, impressions: 1000, avgCtr: 0.01, avgPosition: 7 },
            rows: [{ keys: ["2026-11-01", "best widgets", "/w"], clicks: 10, impressions: 1000, position: 7 }],
          },
        };
      if (key.includes("adsense"))
        return {
          payload: {
            totalsByMetric: { ESTIMATED_EARNINGS: "50" },
            rows: [{ DATE: "2026-11-01", ESTIMATED_EARNINGS: 50 }],
          },
        };
      return { payload: { rows: [{ dimension0: "Organic Search", sessions: 100 }] } };
    });
    mocks.loadPortfolio.mockImplementation(async (_u: unknown, opts: { provider: string }) =>
      opts.provider === "GA4" ? { totals: { sessions: 1000 } } : { totals: { ESTIMATED_EARNINGS: 50, PAGE_RPM: 12.5 } },
    );
  });

  it("derives per-website insights and portfolio summary from snapshots", async () => {
    const out = await loadInsights(user);
    expect(out.websites).toHaveLength(1);
    expect(out.unavailableCount).toBe(1);
    const w = out.websites[0]!;
    expect(w.seo?.strikingDistance[0]?.query).toBe("best widgets");
    expect(w.revenue?.totalEarnings).toBe(50);
    expect(w.channels).toEqual([{ channel: "Organic Search", sessions: 100, sharePercent: 100 }]);
    expect(out.summary.totalEarnings).toBe(50);
    expect(out.summary.blendedPageRpm).toBe(12.5);
    expect(out.summary.earningsPerThousandSessions).toBe(50);
    expect(out.summary.strikingDistanceQueries).toBe(1);
  });

  it("treats lookup failures and partial snapshots honestly", async () => {
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string, provider: string) => {
      if (provider === "ADSENSE") throw new Error("db down");
      return { externalId: `properties/${websiteId}` };
    });
    mocks.readSnapshot.mockImplementation(async (key: string) => {
      if (key.includes("traffic")) throw new Error("cache down");
      if (key.includes("search-console"))
        return { payload: { totals: { clicks: 0, impressions: 0, avgCtr: 0 }, rows: [] } };
      return null;
    });
    mocks.loadPortfolio.mockResolvedValue({ totals: null });
    const out = await loadInsights(user);
    expect(out.websites).toHaveLength(2); // both have the SC snapshot
    expect(out.websites[0]!.revenue).toBeNull();
    expect(out.websites[0]!.channels).toEqual([]);
    expect(out.summary.totalEarnings).toBeNull();
    expect(out.summary.earningsPerThousandSessions).toBeNull();
  });

  it("scopes to accessible websites for restricted users", async () => {
    mocks.listAccessibleWebsiteIds.mockResolvedValue(["w1"]);
    mocks.findMany.mockResolvedValue([{ id: "w1", name: "Site One", domain: "one.example" }]);
    await loadInsights({ ...user, role: "TEAM_MEMBER" });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org1", id: { in: ["w1"] } } }),
    );
  });
});
