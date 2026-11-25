import { describe, it, expect, vi } from "vitest";
import { healthCheckWebsite, type SyncDeps } from "@metricflock/google/sync";

// A-WRK-08: healthCheckWebsite must not early-return on the first
// provider failure — every mapped provider gets a health row on every
// run, and the aggregate reports the failures instead of masking them.
// Google clients + DB/cache touchpoints are fakes, as in
// google-sync-extra.test.ts.
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
  health: Record<string, unknown>[];
} {
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
    getPrimaryIntegration: vi.fn(async (_site: string, provider: string) => ({
      externalId: provider === "GA4" ? "ga4" : provider === "SEARCH_CONSOLE" ? "sc" : "adsense",
    })),
    getWebsiteOrganizationId: vi.fn(async () => "org-1"),
    cacheSet: vi.fn(async () => undefined),
    writeSnapshot: vi.fn(async () => undefined),
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
    ...overrides,
  };
  return { deps: fakes as unknown as SyncDeps, health };
}

function okClient() {
  return {
    auth: {},
    connection: { status: "connected", connectionId: "conn-1", level: "WEBSITE", googleAccountEmail: "o@x" },
  };
}

describe("healthCheckWebsite — no early return on provider failure (A-WRK-08)", () => {
  it("GA4 revoked + AdSense healthy: both get a health row, aggregate is partial", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4") throw new Error("TOKEN_REFRESH_FAILED");
        return okClient();
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({
      status: "partial",
      reports: ["SEARCH_CONSOLE", "ADSENSE"],
      detail: "GA4: TOKEN_REFRESH_FAILED",
    });
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "TOKEN_REFRESH_FAILED" }),
      expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "ok" }),
      expect.objectContaining({ provider: "ADSENSE", status: "ok" }),
    ]);
  });

  it("a generic provider error does not stop the remaining providers", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "sc") throw new Error("search console 500");
        return okClient();
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({
      status: "partial",
      reports: ["GA4", "ADSENSE"],
      detail: "SEARCH_CONSOLE: search console 500",
    });
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "ok" }),
      expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "error", lastError: "search console 500" }),
      expect.objectContaining({ provider: "ADSENSE", status: "ok" }),
    ]);
  });

  it("all providers failing with token errors returns skipped with every failure in the detail", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        throw new Error(integration.externalId === "ga4" ? "TOKEN_REFRESH_FAILED" : "CONNECTION_REVOKED");
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({
      status: "skipped",
      reports: [],
      detail: "GA4: TOKEN_REFRESH_FAILED; SEARCH_CONSOLE: CONNECTION_REVOKED; ADSENSE: CONNECTION_REVOKED",
    });
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error" }),
      expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "error" }),
      expect.objectContaining({ provider: "ADSENSE", status: "error" }),
    ]);
  });

  it("throws the generic error when no provider could be checked at all", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4") throw new Error("database is down");
        throw new Error("TOKEN_REFRESH_FAILED");
      }),
    });
    await expect(healthCheckWebsite("site-1", deps)).rejects.toThrow("database is down");
    // Both failures were still recorded before the throw.
    expect(health).toEqual([
      expect.objectContaining({ provider: "GA4", status: "error", lastError: "database is down" }),
      expect.objectContaining({ provider: "SEARCH_CONSOLE", status: "error" }),
      expect.objectContaining({ provider: "ADSENSE", status: "error" }),
    ]);
  });

  it("a legacy mapping records error health and the check continues (A-DB-12 contract kept)", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4") throw new Error("LEGACY_CONNECTION_MISSING");
        return okClient();
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    // A-DB-12: a legacy mapping is "unmappable", not a provider
    // failure, so it stays untracked in the aggregate — the dashboard
    // surfaces the re-map prompt from the error health row, and the
    // aggregate is ok when every other provider checked fine.
    expect(r).toEqual({ status: "ok", reports: ["SEARCH_CONSOLE", "ADSENSE"] });
    expect(health[0]).toEqual(
      expect.objectContaining({ provider: "GA4", status: "error", lastError: expect.stringContaining("re-map") }),
    );
  });

  it("SCOPE_MISSING records needs_reauth health and the check continues", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4") throw new Error("SCOPE_MISSING");
        return okClient();
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({
      status: "partial",
      reports: ["SEARCH_CONSOLE", "ADSENSE"],
      detail: "GA4: SCOPE_MISSING",
    });
    expect(health[0]).toEqual(
      expect.objectContaining({ provider: "GA4", status: "needs_reauth", lastError: "SCOPE_MISSING" }),
    );
  });

  it("a token error plus a missing connection, none ok, returns skipped with both failures", async () => {
    const { deps, health } = fakeDeps({
      getAuthorizedClientForIntegration: vi.fn(async (_site: string, integration: { externalId: string }) => {
        if (integration.externalId === "ga4") throw new Error("TOKEN_REFRESH_FAILED");
        throw new Error("CONNECTION_REQUIRED");
      }),
    });
    const r = await healthCheckWebsite("site-1", deps);
    expect(r).toEqual({
      status: "skipped",
      reports: [],
      detail: "SEARCH_CONSOLE: not_connected; ADSENSE: not_connected; GA4: TOKEN_REFRESH_FAILED",
    });
    expect(health).toHaveLength(3);
  });
});
