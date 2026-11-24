import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  syncWebsite,
  healthCheckWebsite,
  refreshConnection,
  discoverConnectionProperties,
  defaultSyncDeps,
  type SyncDeps,
} from "@metricflock/google/sync";

// Extra sync-engine coverage beyond sync-engine.test.ts: the
// search-console / adsense / ad-manager kinds, cache-refresh edge
// cases, health-check error branches, discovery filtering/chunking
// with Ad Manager enabled, and the defaultSyncDeps wiring
// (defaultConnectionAuth, default getWebsiteOrganizationId, default
// writeSnapshot). Google clients + DB/cache touchpoints are fakes,
// as in sync-engine.test.ts.
const NOW = new Date("2026-11-19T12:00:00Z");

const moduleMocks = vi.hoisted(() => ({
  websiteFindUnique: vi.fn(),
  recordHealth: vi.fn(),
  snapshotWrite: vi.fn(),
  getValidAccessToken: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { website: { findUnique: moduleMocks.websiteFindUnique } },
}));
vi.mock("@metricflock/db/health", () => ({ recordHealth: moduleMocks.recordHealth }));
vi.mock("@metricflock/db/snapshots", () => ({ writeSnapshot: moduleMocks.snapshotWrite }));
vi.mock("@metricflock/google/tokens", () => ({
  getValidAccessToken: moduleMocks.getValidAccessToken,
}));
vi.mock("@metricflock/google/oauth", () => ({
  getOAuthClient: () => ({ setCredentials: moduleMocks.setCredentials }),
}));

function fakeDeps(overrides: Record<string, unknown> = {}): {
  deps: SyncDeps;
  cacheWrites: { key: string; ttl: number }[];
  health: Record<string, unknown>[];
  snapshots: unknown[];
} {
  const cacheWrites: { key: string; ttl: number }[] = [];
  const health: Record<string, unknown>[] = [];
  const snapshots: unknown[] = [];
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
    writeSnapshot: vi.fn(async (key: string, websiteId: string, payload: unknown, ttl: number) => {
      snapshots.push({ key, websiteId, payload, ttl });
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
      listGa4Properties: vi.fn(async () => ({ items: [], truncated: false, errors: [] })),
      listSearchConsoleSites: vi.fn(async () => ({ items: [], truncated: false })),
      listAdSenseAccounts: vi.fn(async () => ({ items: [], truncated: false })),
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
  const deps = { ...fakes, ...overrides } as unknown as SyncDeps;
  return { deps, cacheWrites, health, snapshots };
}

describe("syncWebsite — remaining kinds", () => {
  it("search-console sync warms one cache entry and a snapshot", async () => {
    const { deps, cacheWrites, snapshots, health } = fakeDeps();
    const r = await syncWebsite("site-1", "search-console", deps);
    expect(r).toEqual({ status: "ok", reports: ["search-console"] });
    expect(cacheWrites).toEqual([
      { key: "analytics:org-1:site-1:123456:search-console:search-console:2026-10-23_2026-11-19:all", ttl: 3600 },
    ]);
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as { ttl: number }).ttl).toBe(28_800);
    expect(health).toEqual([expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "ok" })]);
  });

  it("adsense sync warms one cache entry", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const r = await syncWebsite("site-1", "adsense", deps);
    expect(r).toEqual({ status: "ok", reports: ["adsense"] });
    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0].key).toContain(":adsense:adsense:");
  });

  it("ad-manager sync runs when the feature is enabled", async () => {
    const { deps, cacheWrites, health } = fakeDeps({
      adManager: {
        runAdManagerReport: vi.fn(async () => ({ report: {} })),
        adManagerEnabled: vi.fn(() => true),
        listAdManagerNetworks: vi.fn(async () => []),
      },
    });
    const r = await syncWebsite("site-1", "ad-manager", deps);
    expect(r).toEqual({ status: "ok", reports: ["ad-manager"] });
    expect(cacheWrites).toHaveLength(1);
    expect(deps.adManager.runAdManagerReport).toHaveBeenCalled();
    expect(health).toEqual([expect.objectContaining({ provider: "AD_MANAGER", status: "ok" })]);
  });

  it("an unknown kind throws UNKNOWN_SYNC_KIND", async () => {
    const { deps } = fakeDeps();
    await expect(syncWebsite("site-1", "bogus-kind" as never, deps)).rejects.toThrow("UNKNOWN_SYNC_KIND");
  });

  it("skips rate limiting when the connection id is null", async () => {
    const { deps } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => ({
        auth: {},
        connection: { status: "connected", connectionId: null, level: "WEBSITE", googleAccountEmail: "o@x.com" },
      })),
    });
    const r = await syncWebsite("site-1", "ga4-realtime", deps);
    expect(r.status).toBe("ok");
    expect(deps.rateLimit).not.toHaveBeenCalled();
  });

  it("a failing snapshot write does not fail the sync (Redis is already warm)", async () => {
    const { deps, cacheWrites } = fakeDeps({
      writeSnapshot: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const r = await syncWebsite("site-1", "ga4-realtime", deps);
    expect(r).toEqual({ status: "ok", reports: ["realtime"] });
    expect(cacheWrites).toHaveLength(1);
  });

  it("a failure mid-loop throws after the earlier reports were cached", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runPagesReport = vi.fn(async () => {
      throw new Error("ga4 pages exploded");
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("ga4 pages exploded");
    expect(cacheWrites.map((w) => w.key.split(":")[5])).toEqual(["overview", "traffic", "audience"]);
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "ga4 pages exploded" }),
    ]);
  });
});

describe("syncWebsite — cache-refresh edge cases", () => {
  it("reports skipped/nothing to refresh when nothing is mapped", async () => {
    const { deps } = fakeDeps({ getPrimaryIntegration: vi.fn(async () => null) });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r).toEqual({ status: "skipped", reports: [], detail: "nothing to refresh" });
  });

  it("reports ok with only the mapped providers' reports", async () => {
    const { deps, cacheWrites } = fakeDeps({
      getPrimaryIntegration: vi.fn(async (_site: string, provider: string) =>
        provider === "GA4" ? { externalId: "123456" } : null,
      ),
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("ok");
    expect(r.reports).toEqual(["overview", "traffic", "audience", "pages", "events"]);
    expect(cacheWrites).toHaveLength(5);
  });
});

describe("healthCheckWebsite — error branches", () => {
  it("returns no_mapping when nothing is mapped", async () => {
    const { deps } = fakeDeps({ getPrimaryIntegration: vi.fn(async () => null) });
    await expect(healthCheckWebsite("site-1", deps)).resolves.toEqual({
      status: "no_mapping",
      reports: [],
      detail: "No mapped integrations to check.",
    });
  });

  it("returns not_connected when the first provider has no connection", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("CONNECTION_REQUIRED");
      }),
    });
    await expect(healthCheckWebsite("site-1", deps)).resolves.toEqual({
      status: "not_connected",
      reports: [],
      detail: "No active Google connection for this website or its team.",
    });
    expect(health).toEqual([]);
  });

  it("returns skipped with the providers checked so far on a token error", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "sc") throw new Error("TOKEN_REFRESH_FAILED");
        return {
          auth: {},
          connection: { status: "connected", connectionId: "conn-1", level: "WEBSITE", googleAccountEmail: "o@x" },
        };
      }),
      getPrimaryIntegration: vi.fn(async (_site: string, provider: string) => ({
        externalId: provider === "SEARCH_CONSOLE" ? "sc" : "123456",
      })),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({ status: "skipped", reports: ["GA4"], detail: "TOKEN_REFRESH_FAILED" });
    expect(health).toHaveLength(2);
    expect(health[1]).toEqual(expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "error" }));
  });

  it("throws on a non-token provider error after recording health", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
    });
    await expect(healthCheckWebsite("site-1", deps)).rejects.toThrow("quota exceeded");
    expect(health).toEqual([expect.objectContaining({ provider: "GA4", status: "error" })]);
  });

  it("includes AD_MANAGER when the feature is enabled", async () => {
    const { deps } = fakeDeps({
      adManager: {
        runAdManagerReport: vi.fn(async () => ({})),
        adManagerEnabled: vi.fn(() => true),
        listAdManagerNetworks: vi.fn(async () => []),
      },
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r.status).toBe("ok");
    expect(r.reports).toEqual(["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"]);
  });
});

describe("refreshConnection — non-token errors", () => {
  it("rethrows errors that are not token errors", async () => {
    const { deps } = fakeDeps({
      tokens: {
        getValidAccessToken: vi.fn(async () => {
          throw new Error("database is down");
        }),
      },
    });
    await expect(refreshConnection("conn-1", deps)).rejects.toThrow("database is down");
  });
});

describe("discoverConnectionProperties — filtering, chunking, Ad Manager", () => {
  it("filters out items with empty ids and upserts in chunks of 10", async () => {
    const ga4Items = Array.from({ length: 12 }, (_, i) => ({
      propertyId: `p${i}`,
      displayName: `P${i}`,
      accountId: "9",
    }));
    ga4Items.push({ propertyId: "", displayName: "empty", accountId: "9" });
    const { deps } = fakeDeps({
      discovery: {
        listGa4Properties: vi.fn(async () => ({ items: ga4Items, truncated: false, errors: [] })),
        listSearchConsoleSites: vi.fn(async () => ({
          items: [{ siteUrl: "https://example.com/" }, { siteUrl: "" }],
          truncated: false,
        })),
        listAdSenseAccounts: vi.fn(async () => ({
          items: [{ accountId: "pub-1" }, { accountId: "" }],
          truncated: false,
        })),
      },
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts).toEqual({ ga4: 12, searchConsole: 1, adsense: 1, adManager: 0 });
    expect(deps.prisma.googleProperty.upsert).toHaveBeenCalledTimes(12);
    expect(deps.prisma.searchConsoleProperty.upsert).toHaveBeenCalledTimes(1);
    expect(deps.prisma.adSenseAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it("discovers Ad Manager networks when enabled", async () => {
    const { deps } = fakeDeps({
      adManager: {
        runAdManagerReport: vi.fn(async () => ({})),
        adManagerEnabled: vi.fn(() => true),
        listAdManagerNetworks: vi.fn(async () => [{ networkCode: "123", displayName: "Main" }, { networkCode: "" }]),
      },
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.adManager).toBe(1);
    expect(deps.prisma.adManagerNetwork.upsert).toHaveBeenCalledTimes(1);
    expect(deps.prisma.adManagerNetwork.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_networkCode: { connectionId: "conn-1", networkCode: "123" } },
      }),
    );
  });
});

describe("defaultSyncDeps wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getWebsiteOrganizationId resolves the website's organization", async () => {
    moduleMocks.websiteFindUnique.mockResolvedValue({ organizationId: "org-9" });
    await expect(defaultSyncDeps.getWebsiteOrganizationId("site-1")).resolves.toBe("org-9");
    expect(moduleMocks.websiteFindUnique).toHaveBeenCalledWith({
      where: { id: "site-1" },
      select: { organizationId: true },
    });
  });

  it("getWebsiteOrganizationId throws NOT_FOUND_OR_FORBIDDEN for an unknown website", async () => {
    moduleMocks.websiteFindUnique.mockResolvedValue(null);
    await expect(defaultSyncDeps.getWebsiteOrganizationId("missing")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });

  it("getConnectionAuth exchanges a valid token into an authorized client", async () => {
    moduleMocks.getValidAccessToken.mockResolvedValue("tok-9");
    const auth = await defaultSyncDeps.getConnectionAuth("conn-1");
    expect(moduleMocks.getValidAccessToken).toHaveBeenCalledWith("conn-1");
    expect(moduleMocks.setCredentials).toHaveBeenCalledWith({ access_token: "tok-9" });
    expect(auth).toEqual({ setCredentials: expect.any(Function) });
  });

  it("writeSnapshot delegates to the db snapshot layer", async () => {
    moduleMocks.snapshotWrite.mockResolvedValue(undefined);
    await defaultSyncDeps.writeSnapshot!("cache-key", "site-1", { rows: [] }, 300);
    expect(moduleMocks.snapshotWrite).toHaveBeenCalledWith("cache-key", "site-1", { rows: [] }, 300);
  });

  it("recordHealth is the db health recorder", async () => {
    moduleMocks.recordHealth.mockResolvedValue({});
    await defaultSyncDeps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "ok" });
    expect(moduleMocks.recordHealth).toHaveBeenCalledWith({ websiteId: "site-1", provider: "GA4", status: "ok" });
  });

  it("now() returns the current time", () => {
    const before = Date.now();
    const at = defaultSyncDeps.now().getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe("sync engine — remaining branches", () => {
  it("rethrows a non-token error from client acquisition", async () => {
    const { deps } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw new Error("database is down");
      }),
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("database is down");
  });

  it("stringifies a non-Error thrown while acquiring the client", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw "plain string failure";
      }),
    });
    await expect(syncWebsite("site-1", "adsense", deps)).rejects.toBe("plain string failure");
    expect(health).toEqual([]);
  });

  it("stringifies a non-Error thrown mid-fetch, records health, and rethrows", async () => {
    const { deps, health } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runHistoricalReport = vi.fn(async () => {
      throw "ga4 string failure";
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toBe("ga4 string failure");
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "ga4 string failure" }),
    ]);
  });

  it("stringifies a non-Error in the health check and rethrows it", async () => {
    const { deps } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async () => {
        throw "health string failure";
      }),
    });
    await expect(healthCheckWebsite("site-1", deps)).rejects.toBe("health string failure");
  });

  it("stringifies a non-Error in refreshConnection and rethrows it", async () => {
    const { deps } = fakeDeps({
      tokens: {
        getValidAccessToken: vi.fn(async () => {
          throw "token string failure";
        }),
      },
    });
    await expect(refreshConnection("conn-1", deps)).rejects.toBe("token string failure");
  });

  it("discovery upserts nulls when GA4 properties lack displayName/accountId", async () => {
    const { deps } = fakeDeps({
      discovery: {
        listGa4Properties: vi.fn(async () => ({
          items: [{ propertyId: "p1" }],
          truncated: false,
          errors: [],
        })),
        listSearchConsoleSites: vi.fn(async () => ({ items: [], truncated: false })),
        listAdSenseAccounts: vi.fn(async () => ({ items: [], truncated: false })),
      },
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.ga4).toBe(1);
    expect(deps.prisma.googleProperty.upsert).toHaveBeenCalledWith({
      where: { connectionId_propertyId: { connectionId: "conn-1", propertyId: "p1" } },
      update: { displayName: null, accountId: null },
      create: { connectionId: "conn-1", propertyId: "p1", displayName: null, accountId: null },
    });
  });

  it("discovery upserts null displayName for Ad Manager networks without one", async () => {
    const { deps } = fakeDeps({
      adManager: {
        runAdManagerReport: vi.fn(async () => ({})),
        adManagerEnabled: vi.fn(() => true),
        listAdManagerNetworks: vi.fn(async () => [{ networkCode: "123" }]),
      },
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.adManager).toBe(1);
    expect(deps.prisma.adManagerNetwork.upsert).toHaveBeenCalledWith({
      where: { connectionId_networkCode: { connectionId: "conn-1", networkCode: "123" } },
      update: { displayName: null },
      create: { connectionId: "conn-1", networkCode: "123", displayName: null },
    });
  });
});
