import { describe, it, expect, vi } from "vitest";
import { syncWebsite, type SyncDeps } from "@metricflock/google/sync";

// A-WRK-07: `ga4-historical` (and any multi-report kind) must isolate
// per report — one report's failure must not abort the rest, and the
// retry must not refetch the reports that already warmed. Same fake-deps
// pattern as sync-engine.test.ts (kept local; test files never import
// each other).
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

describe("sync per-report isolation (A-WRK-07)", () => {
  it("a failing 2nd report does not abort the rest: later reports still run, result is partial", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runAudienceReport = vi.fn(async () => {
      throw new Error("ga4 audience exploded");
    });
    const r = await syncWebsite("site-1", "ga4-historical", deps);
    expect(r.status).toBe("partial");
    expect(r.reports).toEqual(["overview", "traffic", "pages", "events"]);
    expect(r.detail).toBe("audience: ga4 audience exploded");
    expect(cacheWrites.map((w) => w.key.split(":")[5])).toEqual(["overview", "traffic", "pages", "events"]);
    // The later reports ran (not aborted by the 3rd report's failure).
    expect(deps.ga4.runPagesReport).toHaveBeenCalled();
    expect(deps.ga4.runEventsReport).toHaveBeenCalled();
    // One error-health record for the failed report; no "ok" record —
    // the provider is degraded, so the error health stands.
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "ga4 audience exploded" }),
    ]);
  });

  it("every report failing still throws the first error so the job FAILS and BullMQ retries", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    const ga4 = deps.ga4 as unknown as Record<string, unknown>;
    ga4.runHistoricalReport = vi.fn(async () => {
      throw new Error("overview down");
    });
    ga4.runTrafficAcquisition = vi.fn(async () => {
      throw new Error("traffic down");
    });
    ga4.runAudienceReport = vi.fn(async () => {
      throw new Error("audience down");
    });
    ga4.runPagesReport = vi.fn(async () => {
      throw new Error("pages down");
    });
    ga4.runEventsReport = vi.fn(async () => {
      throw new Error("events down");
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("overview down");
    expect(cacheWrites).toEqual([]);
    expect(health.filter((h) => h.provider === "GA4" && h.status === "error")).toHaveLength(5);
  });

  it("a quota-shaped failure mid-loop aborts the provider and throws (no more quota burned)", async () => {
    const { deps, cacheWrites, health } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runAudienceReport = vi.fn(async () => {
      throw new Error("Quota exceeded for quota metric 'Queries' and limit 'Queries per day'");
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("Quota exceeded");
    expect(cacheWrites.map((w) => w.key.split(":")[5])).toEqual(["overview", "traffic"]);
    expect(deps.ga4.runPagesReport).not.toHaveBeenCalled();
    expect(deps.ga4.runEventsReport).not.toHaveBeenCalled();
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: expect.stringContaining("Quota") }),
    ]);
  });

  it("a 429-coded error is quota-shaped and aborts the loop", async () => {
    const { deps, cacheWrites } = fakeDeps();
    const err = new Error("request failed") as Error & { code: number };
    err.code = 429;
    (deps.ga4 as unknown as Record<string, unknown>).runAudienceReport = vi.fn(async () => {
      throw err;
    });
    await expect(syncWebsite("site-1", "ga4-historical", deps)).rejects.toThrow("request failed");
    expect(cacheWrites.map((w) => w.key.split(":")[5])).toEqual(["overview", "traffic"]);
    expect(deps.ga4.runPagesReport).not.toHaveBeenCalled();
  });

  it("cache-refresh surfaces a provider partial in the aggregate detail", async () => {
    const { deps, cacheWrites } = fakeDeps();
    (deps.ga4 as unknown as Record<string, unknown>).runAudienceReport = vi.fn(async () => {
      throw new Error("ga4 audience exploded");
    });
    const r = await syncWebsite("site-1", "cache-refresh", deps);
    expect(r.status).toBe("partial");
    expect(r.reports).toEqual(["overview", "traffic", "pages", "events", "search-console", "adsense"]);
    expect(r.detail).toBe("GA4: audience: ga4 audience exploded");
    expect(cacheWrites).toHaveLength(6);
  });

  it("a single-report kind failing still throws (no partial possible)", async () => {
    const { deps, cacheWrites } = fakeDeps();
    (deps.searchConsole as unknown as Record<string, unknown>).querySearchAnalytics = vi.fn(async () => {
      throw new Error("sc down");
    });
    await expect(syncWebsite("site-1", "search-console", deps)).rejects.toThrow("sc down");
    expect(cacheWrites).toEqual([]);
  });
});
