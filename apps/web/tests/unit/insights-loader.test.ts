import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  readSnapshots: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  getPrimaryIntegrations: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({ prisma: { website: { findMany: mocks.findMany } } }));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: mocks.readSnapshots }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: mocks.getPrimaryIntegrations }));

import { loadInsights } from "@/lib/insights";

const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };

const snapshot = (payload: unknown) => ({
  payload,
  expiresAt: new Date(Date.now() + 60_000),
  updatedAt: new Date("2026-11-22T00:00:00Z"),
});

// A-DB-11: the batched mocks. Primaries arrive as one nested map per
// (website, provider); snapshots arrive as one map keyed by cache key,
// with the payload derived from the key's report segment.
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

describe("loadInsights (Phase 7.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.findMany.mockResolvedValue([
      { id: "w1", name: "Site One", domain: "one.example" },
      { id: "w2", name: "Site Two", domain: "two.example" },
    ]);
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
        if (key.includes("w2")) continue; // Site Two has no snapshots yet
        const payload = payloadForKey(key);
        if (payload) out.set(key, snapshot(payload));
      }
      return out;
    });
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
    // A-DB-11: the batch equivalents of the old per-website failures —
    // no AdSense integration anywhere, and no traffic/overview snapshots.
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map();
      for (const id of websiteIds) {
        out.set(
          id,
          new Map(providers.filter((p) => p !== "ADSENSE").map((p) => [p, { externalId: `properties/${id}` }])),
        );
      }
      return out;
    });
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map();
      for (const key of keys) {
        if (!key.includes("search-console")) continue;
        const payload = payloadForKey(key);
        if (payload) out.set(key, snapshot(payload));
      }
      return out;
    });
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

  it("issues one batched primaries query and one batched snapshot query (A-DB-11)", async () => {
    await loadInsights(user);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledTimes(1);
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledWith(["w1", "w2"], ["GA4", "SEARCH_CONSOLE", "ADSENSE"]);
    expect(mocks.readSnapshots).toHaveBeenCalledTimes(1);
    const keys = mocks.readSnapshots.mock.calls[0]![0] as string[];
    // 3 insight reports × 2 sites + GA4 overview × 2 sites; the
    // AdSense insight/portfolio key is shared, so it is not doubled.
    expect(keys).toHaveLength(8);
    expect(mocks.listAccessibleWebsiteIds).toHaveBeenCalledTimes(1);
  });

  it("uses the clamped range for the Search Console key, unclamped for GA4 (A-GGL-07)", async () => {
    await loadInsights(user);
    const keys = mocks.readSnapshots.mock.calls[0]![0] as string[];
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const start = fmt(new Date(today.getTime() - 27 * 86400000));
    const maxEnd = fmt(new Date(today.getTime() - 3 * 86400000));
    const end = fmt(today);
    // The SC snapshot the worker warms lives under the clamped key.
    const scKey = keys.find((k) => k.includes(":search-console:search-console:"));
    expect(scKey).toContain(`:${start}_${maxEnd}:`);
    // GA4 has no data delay — its key keeps the full 28d window.
    const trafficKey = keys.find((k) => k.includes(":ga4:traffic:"));
    expect(trafficKey).toContain(`:${start}_${end}:`);
  });

  // A-API-09: the per-website list is capped at 50 — the response must
  // say so instead of silently under-reporting for larger orgs.
  it("reports truncated with exactly 50 websites' insights past 50 websites", async () => {
    const sites = Array.from({ length: 60 }, (_, i) => ({
      id: `w${i + 1}`,
      name: `Site ${i + 1}`,
      domain: `s${i + 1}.example`,
    }));
    mocks.findMany.mockResolvedValue(sites);
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map();
      for (const key of keys) {
        const payload = payloadForKey(key);
        if (payload) out.set(key, snapshot(payload));
      }
      return out;
    });
    const out = await loadInsights(user);
    expect(out.truncated).toBe(true);
    expect(out.websites).toHaveLength(50);
    expect(out.unavailableCount).toBe(0);
  });

  it("reports truncated false at 50 or fewer websites", async () => {
    const out = await loadInsights(user);
    expect(out.truncated).toBe(false);
  });
});
