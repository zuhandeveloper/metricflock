import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: apps/web/src/lib/analytics-handler.ts —
// classifyAnalyticsError (pure) + handleAnalyticsRequest pipeline
// (auth → website → connection → mapping → cache → snapshot → lock →
// live → error fallbacks) + the thin analytics routes' csv closures.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  assertWebsiteAccess: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getRedis: vi.fn(),
  resolveConnection: vi.fn(),
  getPrimaryIntegration: vi.fn(),
  getAuthorizedClient: vi.fn(),
  lastSuccessfulSync: vi.fn(),
  readSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  loadPortfolio: vi.fn(),
  runPagesReport: vi.fn(),
  runHistoricalReport: vi.fn(),
  runAdSenseReport: vi.fn(),
  querySearchAnalytics: vi.fn(),
}));

vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, requireApiAuth: mocks.requireApiAuth, assertWebsiteAccess: mocks.assertWebsiteAccess };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet, getRedis: mocks.getRedis };
});
vi.mock("@metricflock/google/client", () => ({
  resolveConnectionForWebsite: mocks.resolveConnection,
  getPrimaryIntegration: mocks.getPrimaryIntegration,
  getAuthorizedClientForIntegration: mocks.getAuthorizedClient,
}));
vi.mock("@metricflock/google/ga4", () => ({
  getGa4Client: () => ({}),
  runPagesReport: mocks.runPagesReport,
  runHistoricalReport: mocks.runHistoricalReport,
}));
vi.mock("@metricflock/google/adsense", () => ({ runAdSenseReport: mocks.runAdSenseReport }));
vi.mock("@metricflock/google/search-console", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/google/search-console")>();
  return { ...actual, querySearchAnalytics: mocks.querySearchAnalytics };
});
vi.mock("@metricflock/db/health", () => ({ lastSuccessfulSync: mocks.lastSuccessfulSync }));
vi.mock("@metricflock/db/snapshots", () => ({
  readSnapshot: mocks.readSnapshot,
  writeSnapshot: mocks.writeSnapshot,
}));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));

import { handleAnalyticsRequest, classifyAnalyticsError } from "@/lib/analytics-handler";
import { GET as pagesGet } from "@/app/api/analytics/pages/route";
import { GET as overviewGet } from "@/app/api/analytics/overview/route";
import { GET as adsenseGet } from "@/app/api/analytics/adsense/route";
import { GET as searchConsoleGet } from "@/app/api/analytics/search-console/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const website = { id: "w1", organizationId: "org1", teamId: "t1" };
const baseOpts = {
  permission: "analytics.view" as const,
  provider: "GA4" as const,
  source: "ga4",
  report: "overview",
  cacheTtlSeconds: 300,
  fetchFn: vi.fn(),
};
const req = (path: string) => new NextRequest(`http://localhost${path}`);
const portfolioResult = {
  totals: { sessions: 42 },
  totalsNote: null,
  websiteCount: 1,
  websites: [{ websiteId: "w1", name: "Site", domain: "site.example", snapshotUpdatedAt: "2026-11-23", stale: false }],
  unavailableWebsites: [],
  truncated: false,
};
const fetchFn = baseOpts.fetchFn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.assertWebsiteAccess.mockResolvedValue(website);
  mocks.resolveConnection.mockResolvedValue({ status: "connected" });
  mocks.getPrimaryIntegration.mockResolvedValue({ externalId: "properties/123" });
  mocks.getAuthorizedClient.mockResolvedValue({ auth: {} });
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
  mocks.getRedis.mockReturnValue(null);
  mocks.lastSuccessfulSync.mockResolvedValue(null);
  mocks.readSnapshot.mockResolvedValue(null);
  mocks.writeSnapshot.mockResolvedValue(undefined);
  mocks.loadPortfolio.mockResolvedValue(portfolioResult);
  fetchFn.mockResolvedValue({ rows: [{ sessions: 7 }] });
});

describe("classifyAnalyticsError", () => {
  it("api_not_enabled / scope_missing / temporarily_unavailable", () => {
    expect(classifyAnalyticsError(new Error("SERVICE_DISABLED: api not enabled"))).toBe("api_not_enabled");
    expect(classifyAnalyticsError(new Error("API analytics.googleapis.com has not been used"))).toBe("api_not_enabled");
    expect(classifyAnalyticsError(new Error("SCOPE_MISSING for GA4"))).toBe("scope_missing");
    expect(classifyAnalyticsError(new Error("TOKEN_REFRESH_LOCK_UNAVAILABLE"))).toBe("temporarily_unavailable");
    expect(classifyAnalyticsError(new Error("GOOGLE_API_TIMEOUT after 15s"))).toBe("temporarily_unavailable");
    expect(classifyAnalyticsError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      "temporarily_unavailable",
    );
  });
  it("quota / permission / auth / invalid-request / default", () => {
    expect(classifyAnalyticsError(new Error("quota exceeded for project"))).toBe("google_quota_exceeded");
    expect(classifyAnalyticsError(Object.assign(new Error("x"), { code: 8 }))).toBe("google_quota_exceeded");
    expect(
      classifyAnalyticsError(
        Object.assign(new Error("denied"), { response: { data: { error: { status: "PERMISSION_DENIED" } } } }),
      ),
    ).toBe("permission_denied");
    expect(classifyAnalyticsError(Object.assign(new Error("x"), { code: 7 }))).toBe("permission_denied");
    expect(classifyAnalyticsError(new Error("invalid_grant: token expired"))).toBe("unauthorized");
    expect(classifyAnalyticsError(Object.assign(new Error("x"), { code: 16 }))).toBe("unauthorized");
    expect(classifyAnalyticsError(new Error("INVALID_ARGUMENT: bad dimension"))).toBe("invalid_request");
    expect(classifyAnalyticsError(Object.assign(new Error("x"), { code: 3 }))).toBe("invalid_request");
    expect(classifyAnalyticsError(new Error("something entirely new"))).toBe("google_api_error");
    expect(classifyAnalyticsError("plain string failure")).toBe("google_api_error");
  });
});

describe("handleAnalyticsRequest — auth, input, access", () => {
  it("unauthenticated → 401; invalid query → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1"), baseOpts)).status).toBe(401);
    const bad = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=banana"), baseOpts);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
  it("no websiteId → org-wide portfolio aggregate envelope (snapshot freshness)", async () => {
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?range=28d"), baseOpts);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      freshness: "snapshot",
      data: { totals: { sessions: 42 } },
      includedWebsites: ["w1"],
    });
    expect(mocks.loadPortfolio).toHaveBeenCalledWith(admin, expect.objectContaining({ provider: "GA4" }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("no websiteId + no snapshots → freshness unavailable", async () => {
    mocks.loadPortfolio.mockResolvedValue({ ...portfolioResult, websites: [], websiteCount: 0 });
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?range=28d"), baseOpts);
    expect((await res.json()).freshness).toBe("unavailable");
  });
  it("cross-tenant website → 404", async () => {
    mocks.assertWebsiteAccess.mockRejectedValueOnce(new Error("NOT_FOUND_OR_FORBIDDEN"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w9&range=28d"), baseOpts);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found_or_forbidden" });
  });
  it("unconnected → 200 not_connected; no mapping → 200 missing_data", async () => {
    mocks.resolveConnection.mockResolvedValueOnce({ status: "not_connected" });
    const nc = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect((await nc.json()).status).toBe("not_connected");
    mocks.getPrimaryIntegration.mockResolvedValueOnce(null);
    const md = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect((await md.json()).status).toBe("missing_data");
  });
  it("client auth CONNECTION_REQUIRED → not_connected; other auth error → classified 502", async () => {
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("CONNECTION_REQUIRED"));
    const nc = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect((await nc.json()).status).toBe("not_connected");
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("token refresh exploded"));
    const err = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(err.status).toBe(502);
    // API-9: raw provider text stays server-side; the client gets the stable code + requestId.
    // A-GGL-15: the code is the classified one (google_api_error), not the old connection_error.
    expect(await err.json()).toMatchObject({ error: "google_api_error", requestId: expect.any(String) });
  });
  it("client auth SCOPE_MISSING → scope_missing, same contract as the fetch path (A-GGL-15)", async () => {
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("SCOPE_MISSING for GA4"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "scope_missing", requestId: expect.any(String) });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("client auth TOKEN_REFRESH_LOCK_UNAVAILABLE → temporarily_unavailable; quota → 429 (A-GGL-15)", async () => {
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("TOKEN_REFRESH_LOCK_UNAVAILABLE"));
    const busy = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(busy.status).toBe(502);
    expect(await busy.json()).toMatchObject({ error: "temporarily_unavailable" });
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("quota exceeded for project"));
    const quota = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(quota.status).toBe(429);
    expect(await quota.json()).toMatchObject({ error: "google_quota_exceeded" });
  });
  it("legacy mapping without a connection → 200 missing_data prompting re-map (A-DB-12)", async () => {
    mocks.getAuthorizedClient.mockRejectedValueOnce(new Error("LEGACY_CONNECTION_MISSING"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("missing_data");
    expect(body.unavailableWebsites[0].reason).toMatch(/re-map/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("handleAnalyticsRequest — cache / snapshot / live", () => {
  it("Redis hit → cached envelope with lastSyncedAt", async () => {
    mocks.cacheGet.mockResolvedValue({ value: { rows: [{ sessions: 3 }] }, stale: false });
    mocks.lastSuccessfulSync.mockResolvedValue("2026-11-23T00:00:00.000Z");
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", freshness: "cached", data: { rows: [{ sessions: 3 }] } });
    expect(body.lastSyncedAt).toBe("2026-11-23T00:00:00.000Z");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("fresh DB snapshot → snapshot envelope + Redis re-warm", async () => {
    mocks.readSnapshot.mockResolvedValue({
      payload: { rows: [{ sessions: 9 }] },
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    const body = await res.json();
    expect(body).toMatchObject({ freshness: "snapshot", data: { rows: [{ sessions: 9 }] } });
    expect(mocks.cacheSet).toHaveBeenCalledWith(
      expect.stringContaining("analytics:org1:w1"),
      { rows: [{ sessions: 9 }] },
      300,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("live fetch → live envelope + cache + snapshot writes", async () => {
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", freshness: "live", data: { rows: [{ sessions: 7 }] } });
    expect(fetchFn).toHaveBeenCalledWith(expect.objectContaining({ propertyId: "properties/123", websiteId: "w1" }));
    expect(mocks.cacheSet).toHaveBeenCalled();
    expect(mocks.writeSnapshot).toHaveBeenCalled();
  });
  it("format=csv → text/csv attachment instead of JSON", async () => {
    const csv = (data: unknown) => `sessions\n${(data as { rows: { sessions: number }[] }).rows[0].sessions}\n`;
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d&format=csv"), {
      ...baseOpts,
      csv,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain('filename="overview-w1.csv"');
    expect(await res.text()).toBe("sessions\n7\n");
  });
  it("Redis lock held by a winner → waits, then serves the winner's cache write", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null), // not OK → lock not acquired
      eval: vi.fn().mockResolvedValue(0),
    };
    mocks.getRedis.mockReturnValue(redis);
    mocks.cacheGet
      .mockResolvedValueOnce(null) // initial miss
      .mockResolvedValueOnce({ value: { rows: [{ sessions: 11 }] }, stale: false }); // poll hit
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    const body = await res.json();
    expect(body).toMatchObject({ freshness: "cached", data: { rows: [{ sessions: 11 }] } });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("lock:fetch:"),
      expect.any(String),
      "PX",
      30_000,
      "NX",
    );
  });
  it("lock acquired → fetch runs, lock released via Lua eval in finally", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    };
    mocks.getRedis.mockReturnValue(redis);
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect((await res.json()).freshness).toBe("live");
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      expect.stringContaining("lock:fetch:"),
      expect.any(String),
    );
  });
});

describe("handleAnalyticsRequest — provider errors", () => {
  it("fetch fails + stale Redis value → stale envelope", async () => {
    mocks.cacheGet.mockResolvedValue({ value: { rows: [{ sessions: 2 }] }, stale: true });
    fetchFn.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", freshness: "stale", data: { rows: [{ sessions: 2 }] } });
  });
  it("fetch fails + stale DB snapshot → stale envelope from the snapshot", async () => {
    mocks.readSnapshot.mockResolvedValue({
      payload: { rows: [{ sessions: 4 }] },
      updatedAt: new Date(Date.now() - 3600_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    fetchFn.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    const body = await res.json();
    expect(body).toMatchObject({ freshness: "stale", data: { rows: [{ sessions: 4 }] } });
  });
  it("fetch fails + nothing stale → 502 google_api_error with requestId", async () => {
    fetchFn.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("google_api_error");
    expect(typeof body.requestId).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
  it("quota error → 429 google_quota_exceeded", async () => {
    fetchFn.mockRejectedValueOnce(new Error("quota exceeded for project"));
    const res = await handleAnalyticsRequest(req("/api/analytics/overview?websiteId=w1&range=28d"), baseOpts);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "google_quota_exceeded" });
  });
});

describe("thin analytics routes — csv closures", () => {
  it("pages route csv → text/csv with the fetched rows", async () => {
    mocks.runPagesReport.mockResolvedValue({ rows: [{ page: "/x", sessions: 3 }] });
    const res = await pagesGet(req("/api/analytics/pages?websiteId=w1&range=28d&format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("/x");
    expect(text).toContain("3");
    expect(mocks.runPagesReport).toHaveBeenCalled();
  });
  it("overview route csv → text/csv", async () => {
    mocks.runHistoricalReport.mockResolvedValue({ rows: [{ sessions: 7 }] });
    const res = await overviewGet(req("/api/analytics/overview?websiteId=w1&range=28d&format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(await res.text()).toContain("7");
  });
  it("adsense route csv → text/csv", async () => {
    mocks.runAdSenseReport.mockResolvedValue({ rows: [{ earnings: 1.5 }] });
    const res = await adsenseGet(req("/api/analytics/adsense?websiteId=w1&range=28d&format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(await res.text()).toContain("1.5");
  });
  it("search-console route csv → text/csv", async () => {
    mocks.querySearchAnalytics.mockResolvedValue({ rows: [{ query: "q", clicks: 1 }] });
    const res = await searchConsoleGet(req("/api/analytics/search-console?websiteId=w1&range=28d&format=csv"));
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(await res.text()).toContain("q");
  });

  it("search-console 28d clamps endDate to 3 days ago and the envelope reports the effective range (A-GGL-07)", async () => {
    mocks.querySearchAnalytics.mockResolvedValue({ rows: [{ query: "q", clicks: 1 }] });
    const res = await searchConsoleGet(req("/api/analytics/search-console?websiteId=w1&range=28d"));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const expectedEnd = fmt(new Date(today.getTime() - 3 * 86400000));
    const expectedStart = fmt(new Date(today.getTime() - 27 * 86400000));
    // The Google call never asks for days with no data yet.
    expect(mocks.querySearchAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedStart,
      expectedEnd,
      expect.anything(),
    );
    const body = await res.json();
    expect(body.range).toEqual({ startDate: expectedStart, endDate: expectedEnd });
  });

  it("GA4 28d is NOT clamped (A-GGL-07)", async () => {
    mocks.runHistoricalReport.mockResolvedValue({ summary: { totalUsers: 10 } });
    const res = await overviewGet(req("/api/analytics/overview?websiteId=w1&range=28d"));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const expectedStart = fmt(new Date(today.getTime() - 27 * 86400000));
    expect(mocks.runHistoricalReport).toHaveBeenCalledWith(
      expect.anything(),
      "properties/123",
      expectedStart,
      fmt(today),
    );
    expect((await res.json()).range).toEqual({ startDate: expectedStart, endDate: fmt(today) });
  });
});
