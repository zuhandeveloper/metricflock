import { describe, it, expect, vi } from "vitest";
import { syncWebsite, type SyncDeps } from "@metricflock/google/sync";

// A-GGL-12: cache-refresh must isolate providers — one provider's throw
// must not abort the others' cache warming. Same fake-deps pattern as
// sync-engine.test.ts (kept local; test files never import each other).
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

function throwGa4(deps: SyncDeps, message: string) {
  // A-WRK-07: per-report isolation means failing only the overview
  // report no longer models "GA4 is down" — the other four reports
  // would still warm and the provider would return "partial". A
  // provider outage fails every report, so all five fns throw here;
  // the tests below keep asserting the all-failed contract (job FAILS,
  // BullMQ retries) on that basis.
  const failing = vi.fn(async () => {
    throw new Error(message);
  });
  const ga4 = deps.ga4 as unknown as Record<string, unknown>;
  ga4.runHistoricalReport = failing;
  ga4.runTrafficAcquisition = failing;
  ga4.runAudienceReport = failing;
  ga4.runPagesReport = failing;
  ga4.runEventsReport = failing;
}

describe("cache-refresh per-provider isolation (A-GGL-12)", () => {
  it("GA4 throwing does not starve SC/AdSense: partial, their caches warmed, GA4 failed + health error", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    throwGa4(deps, "quota exceeded");
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("partial");
    expect(r.reports).toEqual(["search-console", "adsense"]);
    expect(r.detail).toBe("GA4: quota exceeded");
    expect(cacheWrites).toHaveLength(2);
    // GA4's fetch error is recorded by syncOneProvider AND by the
    // cache-refresh catch (identical values, upserted) — both records
    // are error rows; SC/AdSense stay ok.
    expect(health.filter((h) => h.provider === "GA4" && h.status === "error")).toHaveLength(2);
    expect(health).toContainEqual(expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "ok" }));
    expect(health).toContainEqual(expect.objectContaining({ provider: "ADSENSE", status: "ok" }));
  });

  it("nothing warmed + a throw: re-throws the first error so the job FAILS and BullMQ retries", async () => {
    const { deps, cacheWrites } = fakeDeps();
    throwGa4(deps, "ga4 down");
    (deps.searchConsole as unknown as Record<string, unknown>).querySearchAnalytics = vi.fn(async () => {
      throw new Error("sc down");
    });
    (deps.adsense as unknown as Record<string, unknown>).runAdSenseReport = vi.fn(async () => {
      throw new Error("adsense down");
    });
    await expect(syncWebsite("site-1", "cache-refresh", deps)).rejects.toThrow("ga4 down");
    expect(cacheWrites).toEqual([]);
  });

  it("all four providers throwing (Ad Manager enabled) re-throws the first error", async () => {
    const { deps, cacheWrites } = fakeDeps({
      adManager: {
        runAdManagerReport: vi.fn(async () => {
          throw new Error("adm down");
        }),
        adManagerEnabled: vi.fn(() => true),
        listAdManagerNetworks: vi.fn(async () => []),
      },
    });
    throwGa4(deps, "ga4 down");
    (deps.searchConsole as unknown as Record<string, unknown>).querySearchAnalytics = vi.fn(async () => {
      throw new Error("sc down");
    });
    (deps.adsense as unknown as Record<string, unknown>).runAdSenseReport = vi.fn(async () => {
      throw new Error("adsense down");
    });
    await expect(syncWebsite("site-1", "cache-refresh", deps)).rejects.toThrow("ga4 down");
    expect(cacheWrites).toEqual([]);
  });

  it("a terminal provider (not_connected) does not make a successful refresh partial", async () => {
    const { deps, cacheWrites } = fakeDeps({
      getPrimaryIntegration: vi.fn(async (_site: string, provider: string) =>
        provider === "SEARCH_CONSOLE" ? { externalId: "sc-1" } : { externalId: "123456" },
      ),
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "sc-1") throw new Error("CONNECTION_REQUIRED");
        return {
          auth: {},
          connection: {
            status: "connected",
            connectionId: "conn-1",
            level: "WEBSITE",
            googleAccountEmail: "owner@example.com",
          },
        };
      }),
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("ok");
    // GA4 (5) + AdSense (1); SC not_connected, Ad Manager disabled.
    expect(r.reports).toHaveLength(6);
    expect(cacheWrites).toHaveLength(6);
  });

  it("a throw from client resolution is recorded as health error and does not abort the rest", async () => {
    const { deps, cacheWrites, health } = fakeDeps({
      getPrimaryIntegration: vi.fn(async (_site: string, provider: string) =>
        provider === "GA4" ? { externalId: "ga4-1" } : { externalId: "123456" },
      ),
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4-1") throw new Error("network down");
        return {
          auth: {},
          connection: {
            status: "connected",
            connectionId: "conn-1",
            level: "WEBSITE",
            googleAccountEmail: "owner@example.com",
          },
        };
      }),
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("partial");
    expect(r.detail).toBe("GA4: network down");
    expect(cacheWrites).toHaveLength(2);
    // Pre-fetch throws are recorded ONLY by the cache-refresh catch —
    // syncOneProvider never records them.
    expect(health.filter((h) => h.provider === "GA4" && h.status === "error")).toHaveLength(1);
  });

  it("rate limiting on one provider is partial without an error health record", async () => {
    const { deps, cacheWrites, health } = fakeDeps({
      rateLimit: vi
        .fn()
        .mockResolvedValueOnce({ allowed: false, remaining: 0 })
        .mockResolvedValue({ allowed: true, remaining: 29 }),
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("partial");
    expect(r.detail).toBe("GA4: SYNC_RATE_LIMITED:conn-1");
    expect(cacheWrites).toHaveLength(2);
    expect(health.filter((h) => h.provider === "GA4")).toHaveLength(0);
    expect(health).toContainEqual(expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "ok" }));
  });

  it("a failing health write does not abort the remaining providers", async () => {
    const { deps, cacheWrites } = fakeDeps();
    throwGa4(deps, "quota exceeded");
    // The second GA4 error-health write (the one from the cache-refresh
    // catch) fails; the refresh must still warm SC/AdSense and keep the
    // original error in the detail instead of aborting on the write.
    let ga4ErrorWrites = 0;
    (deps as unknown as Record<string, unknown>).recordHealth = vi.fn(async (opts: Record<string, unknown>) => {
      if (opts.provider === "GA4" && opts.status === "error") {
        ga4ErrorWrites += 1;
        if (ga4ErrorWrites === 2) throw new Error("db down");
      }
      return {};
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("partial");
    expect(r.detail).toBe("GA4: quota exceeded");
    expect(cacheWrites).toHaveLength(2);
  });

  it("nothing mapped and nothing thrown stays skipped, as before", async () => {
    const { deps, cacheWrites } = fakeDeps({
      getPrimaryIntegration: vi.fn(async () => null),
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r).toEqual({ status: "skipped", reports: [], detail: "nothing to refresh" });
    expect(cacheWrites).toEqual([]);
  });
});
