import { describe, it, expect, vi } from "vitest";
import {
  syncWebsite,
  refreshConnection,
  discoverConnectionProperties,
  last28Days,
  SyncRateLimitError,
  type SyncDeps,
} from "@metricflock/google/sync";

// Mocked Google clients + DB/cache touchpoints (spec §23). These tests prove
// the engine's orchestration; they are NOT live Google verification.
const NOW = new Date("2026-11-19T12:00:00Z");

function fakeDeps(overrides: Record<string, unknown> = {}): {
  deps: SyncDeps;
  cacheWrites: { key: string; ttl: number }[];
  health: Record<string, unknown>[];
} {
  const cacheWrites: { key: string; ttl: number }[] = [];
  const health: Record<string, unknown>[] = [];
  const fakes = {
    getAuthorizedClientForWebsite: vi.fn(async () => ({
      auth: {},
      connection: {
        status: "connected",
        connectionId: "conn-1",
        level: "WEBSITE",
        googleAccountEmail: "owner@example.com",
      },
    })),
    getAuthorizedClientForIntegration: vi.fn(async () => ({
      auth: {},
      connection: {
        status: "connected",
        connectionId: "conn-1",
        level: "WEBSITE",
        googleAccountEmail: "owner@example.com",
      },
    })),
    getPrimaryIntegration: vi.fn(async () => ({ externalId: "123456" })),
    getWebsiteOrganizationId: vi.fn(async () => "org-1"),
    cacheSet: vi.fn(async (key: string, _value: unknown, ttl: number) => {
      cacheWrites.push({ key, ttl });
    }),
    recordHealth: vi.fn(async (opts: Record<string, unknown>) => {
      health.push(opts);
      return {};
    }),
    rateLimit: vi.fn(async () => ({ allowed: true, remaining: 29 })),
    ga4: {
      getGa4Client: vi.fn(() => ({})),
      runRealtimeReport: vi.fn(async () => ({ activeUsers: 3 })),
      runHistoricalReport: vi.fn(async () => ({ summary: { totalUsers: 10 } })),
      runTrafficAcquisition: vi.fn(async () => ({ rows: [] })),
      runAudienceReport: vi.fn(async () => ({ rows: [] })),
      runPagesReport: vi.fn(async () => ({ rows: [] })),
      runEventsReport: vi.fn(async () => ({ rows: [] })),
    },
    searchConsole: { querySearchAnalytics: vi.fn(async () => ({ totals: { clicks: 5 } })) },
    adsense: { runAdSenseReport: vi.fn(async () => ({ rows: [] })) },
    adManager: {
      runAdManagerReport: vi.fn(async () => ({ report: {} })),
      adManagerEnabled: vi.fn(() => false),
      listAdManagerNetworks: vi.fn(async () => []),
    },
    discovery: {
      listGa4Properties: vi.fn(async () => ({
        items: [{ propertyId: "111", displayName: "Site GA4", accountId: "9" }],
        truncated: false,
        errors: [],
      })),
      listSearchConsoleSites: vi.fn(async () => ({
        items: [{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }],
        truncated: false,
      })),
      listAdSenseAccounts: vi.fn(async () => ({
        items: [{ accountId: "pub-1", displayName: "Pub" }],
        truncated: false,
      })),
    },
    tokens: { getValidAccessToken: vi.fn(async () => "access-token") },
    getConnectionAuth: vi.fn(async () => ({})),
    prisma: {
      googleProperty: { upsert: vi.fn(async () => ({})) },
      searchConsoleProperty: { upsert: vi.fn(async () => ({})) },
      adSenseAccount: { upsert: vi.fn(async () => ({})) },
      adManagerNetwork: { upsert: vi.fn(async () => ({})) },
    },
    now: () => NOW,
  };
  // Mocked clients (spec §23): runtime fakes, cast once to the deps contract.
  const deps = { ...fakes, ...overrides } as unknown as SyncDeps;
  return { deps, cacheWrites, health };
}

describe("sync engine (mocked Google clients)", () => {
  it("last28Days matches the web handler's 28d window", () => {
    expect(last28Days(NOW)).toEqual({ startDate: "2026-10-23", endDate: "2026-11-19" });
  });

  it("search-console sync clamps the range to 3 days ago, fetch and cache key alike (A-GGL-07)", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const r = await syncWebsite("site-1", "search-console", deps);
    expect(r.status).toBe("ok");
    // The Google call never asks for days with no data yet.
    expect(deps.searchConsole.querySearchAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      "123456",
      "2026-10-23",
      "2026-11-16",
      ["date", "query", "page"],
    );
    // And the warmed cache key matches the key the web handler builds
    // for the same requested range, so the dashboard hits it.
    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0]!.key).toContain("2026-10-23_2026-11-16");
  });

  it("ga4-historical sync keeps the unclamped 28-day window (A-GGL-07)", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("ok");
    expect(deps.ga4.runHistoricalReport).toHaveBeenCalledWith(expect.anything(), "123456", "2026-10-23", "2026-11-19");
    expect(cacheWrites[0]!.key).toContain("2026-10-23_2026-11-19");
  });

  it("returns not_connected without fetching or caching", async () => {
    const { deps, cacheWrites } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("CONNECTION_REQUIRED");
      }),
    });
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("not_connected");
    expect(cacheWrites).toEqual([]);
    expect(deps.ga4.runHistoricalReport).not.toHaveBeenCalled();
  });

  it("returns no_mapping when no property is mapped", async () => {
    const { deps, cacheWrites } = fakeDeps({ getPrimaryIntegration: vi.fn(async () => null) });
    const r = await syncWebsite("site-1", "search-console", deps);
    expect(r.status).toBe("no_mapping");
    expect(cacheWrites).toEqual([]);
  });

  it("returns no_mapping for a legacy mapping without a connection (A-DB-12)", async () => {
    // Terminal, not a retry: no credential can fix a mapping that was
    // never linked to a connection, and the fallback to another
    // connection's token is gone.
    const { deps, cacheWrites } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("LEGACY_CONNECTION_MISSING");
      }),
    });
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("no_mapping");
    expect(r.detail).toMatch(/re-map/);
    expect(cacheWrites).toEqual([]);
    expect(deps.ga4.runHistoricalReport).not.toHaveBeenCalled();
  });

  it("health-check records error health for a legacy mapping and does not throw (A-DB-12)", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("LEGACY_CONNECTION_MISSING");
      }),
    });
    const r = await syncWebsite("site-1", "health-check", deps);
    expect(r.status).toBe("no_mapping");
    // GA4 + Search Console + AdSense all hit the legacy error (Ad Manager
    // is disabled in the fakes); each records error health, none throws.
    expect(health).toHaveLength(3);
    for (const h of health) {
      expect(h).toMatchObject({ status: "error" });
      expect(String(h.lastError)).toMatch(/re-map/);
    }
  });

  it("GA4 historical fetches all 5 reports and warms the web cache keys", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("ok");
    expect(r.reports).toEqual(["overview", "traffic", "audience", "pages", "events"]);
    expect(cacheWrites.map((w) => w.key)).toEqual([
      "analytics:org-1:site-1:123456:ga4:overview:2026-10-23_2026-11-19:all",
      "analytics:org-1:site-1:123456:ga4:traffic:2026-10-23_2026-11-19:all",
      "analytics:org-1:site-1:123456:ga4:audience:2026-10-23_2026-11-19:all",
      "analytics:org-1:site-1:123456:ga4:pages:2026-10-23_2026-11-19:all",
      "analytics:org-1:site-1:123456:ga4:events:2026-10-23_2026-11-19:all",
    ]);
    expect(cacheWrites.every((w) => w.ttl === 300)).toBe(true);
    expect(health).toEqual([expect.objectContaining({ provider: "GA4", status: "ok", success: true })]);
  });

  it("realtime writes one cache entry with the 30s TTL", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const r = await syncWebsite("site-1", "ga4-realtime", deps);
    expect(r).toEqual({ status: "ok", reports: ["realtime"] });
    expect(cacheWrites).toEqual([
      { key: "analytics:org-1:site-1:123456:ga4:realtime:2026-10-23_2026-11-19:all", ttl: 30 },
    ]);
  });

  it("Google API errors throw (retryable) and record health error", async () => {
    const { deps, health } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runHistoricalReport = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("quota exceeded");
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "quota exceeded" }),
    ]);
  });

  it("per-connection rate limiting throws SyncRateLimitError before fetching", async () => {
    const { deps } = fakeDeps({ rateLimit: vi.fn(async () => ({ allowed: false, remaining: 0 })) });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toBeInstanceOf(SyncRateLimitError);
    expect(deps.ga4.runHistoricalReport).not.toHaveBeenCalled();
  });

  it("A-GGL-19: the sync quota guard fails closed on Redis errors (no unthrottled fetch)", async () => {
    // The real limiter returns allowed:false on a Redis error when failClosed
    // is set (pinned in rate-limit-failclosed.test.ts), and allowed:false
    // throws SyncRateLimitError before fetching (pinned above), which the
    // worker turns into a BullMQ delay — so the sync must pass
    // { failClosed: true }, or a Redis outage degrades the per-connection
    // quota guard to a per-process one that multiplies per worker instance.
    const rateLimit = vi.fn(async () => ({ allowed: true, remaining: 29 }));
    const { deps } = fakeDeps({ rateLimit });
    await syncWebsite("site-1", "ga4-historical", deps);
    expect(rateLimit).toHaveBeenCalledWith("google:conn-1", 30, 60_000, { failClosed: true });
  });

  it("Ad Manager disabled returns disabled without fetching", async () => {
    const { deps } = fakeDeps();
    const r = await syncWebsite("site-1", "ad-manager", deps);
    expect(r.status).toBe("disabled");
    expect(deps.adManager.runAdManagerReport).not.toHaveBeenCalled();
  });

  it("revoked token returns skipped (no retry burn) and records health", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("CONNECTION_REVOKED");
      }),
    });
    const r = await syncWebsite("site-1", "adsense", deps);
    expect(r.status).toBe("skipped");
    expect(health).toEqual([
      expect.objectContaining({ provider: "ADSENSE", status: "error", lastError: "CONNECTION_REVOKED" }),
    ]);
  });

  it("SCOPE_MISSING returns skipped with needs_reauth health (A-GGL-04, no retry burn)", async () => {
    const { deps, health, cacheWrites } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("SCOPE_MISSING");
      }),
    });
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r).toEqual({ status: "skipped", reports: [], detail: "SCOPE_MISSING" });
    expect(cacheWrites).toEqual([]);
    expect(deps.ga4.runHistoricalReport).not.toHaveBeenCalled();
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "needs_reauth", lastError: "SCOPE_MISSING" }),
    ]);
  });

  it("health check returns skipped with needs_reauth health on SCOPE_MISSING (A-GGL-04)", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("SCOPE_MISSING");
      }),
    });
    const r = await syncWebsite("site-1", "health-check", deps);
    expect(r.status).toBe("skipped");
    // A-WRK-08: the detail now lists every failed provider instead of
    // only the first failure's message.
    expect(r.detail).toBe("GA4: SCOPE_MISSING; SEARCH_CONSOLE: SCOPE_MISSING; ADSENSE: SCOPE_MISSING");
    // A-WRK-08: the check no longer aborts on the first provider — every
    // mapped provider gets its own needs_reauth health record.
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "needs_reauth", lastError: "SCOPE_MISSING" }),
      expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "needs_reauth", lastError: "SCOPE_MISSING" }),
      expect.objectContaining({ provider: "ADSENSE", status: "needs_reauth", lastError: "SCOPE_MISSING" }),
    ]);
  });

  it("refreshConnection: skipped on SCOPE_MISSING (A-GGL-04)", async () => {
    const bad = fakeDeps({
      tokens: {
        getValidAccessToken: vi.fn(async () => {
          throw new Error("SCOPE_MISSING");
        }),
      },
    });
    expect((await refreshConnection("conn-1", bad.deps)).status).toBe("skipped");
  });

  it("cache-refresh warms every mapped provider", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("ok");
    // GA4 (5) + Search Console (1) + AdSense (1); Ad Manager disabled.
    expect(cacheWrites).toHaveLength(7);
  });

  it("health check records ok per mapped provider", async () => {
    const { deps, health } = fakeDeps();
    const r = await syncWebsite("site-1", "health-check", deps);
    expect(r.status).toBe("ok");
    expect(r.reports).toEqual(["GA4", "SEARCH_CONSOLE", "ADSENSE"]);
    expect(health).toHaveLength(3);
  });

  it("refreshConnection: ok on success, skipped on revoked grant", async () => {
    const ok = fakeDeps();
    expect(await refreshConnection("conn-1", ok.deps)).toEqual({ status: "ok", reports: [] });
    const bad = fakeDeps({
      tokens: {
        getValidAccessToken: vi.fn(async () => {
          throw new Error("CONNECTION_REVOKED");
        }),
      },
    });
    expect((await refreshConnection("conn-1", bad.deps)).status).toBe("skipped");
  });

  it("DATA-5: authorizes via the connection the mapping was made under", async () => {
    const integration = { externalId: "123456", googleConnectionId: "conn-mapped" };
    const { deps } = fakeDeps({ getPrimaryIntegration: vi.fn(async () => integration) });
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("ok");
    expect(deps.getAuthorizedClientForIntegration).toHaveBeenCalledWith("site-1", integration);
    expect(deps.getAuthorizedClientForWebsite).not.toHaveBeenCalled();
  });

  it("discovery upserts properties and returns counts", async () => {
    const { deps } = fakeDeps();
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts).toEqual({ ga4: 1, searchConsole: 1, adsense: 1, adManager: 0 });
    expect(deps.prisma.googleProperty.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_propertyId: { connectionId: "conn-1", propertyId: "111" } },
      }),
    );
  });
});
