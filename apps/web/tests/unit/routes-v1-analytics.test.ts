import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-COV-04 (Stage 1, row 17): route-level integration tests (mocked
// Prisma) for the 19 unexercised handlers — starting with the 5 v1 routes
// and 8 analytics routes, plus insights, integrations/health,
// reports/send-test, auth/logout, invites/accept and members/invite/[id].
// Transfer cancel/reject are covered in transfer.test.ts. Each route:
// unauthenticated → 401, cross-tenant → 404, valid → 200 shape.
const mocks = vi.hoisted(() => ({
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdate: vi.fn(),
  apiKeyCount: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteFindFirst: vi.fn(),
  websiteCount: vi.fn(),
  orgFindUnique: vi.fn(),
  orgDelete: vi.fn(),
  orgDeleteMany: vi.fn(),
  txQueryRaw: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteUpdate: vi.fn(),
  inviteCount: vi.fn(),
  inviteDelete: vi.fn(),
  userCount: vi.fn(),
  userUpdate: vi.fn(),
  teamCount: vi.fn(),
  connectionCount: vi.fn(),
  tx: vi.fn(),
  rateLimit: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getRedis: vi.fn(),
  requireApiAuth: vi.fn(),
  assertWebsiteAccess: vi.fn(),
  getSessionUser: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  destroySession: vi.fn(),
  resolveConnection: vi.fn(),
  getPrimaryIntegration: vi.fn(),
  getAuthorizedClient: vi.fn(),
  readSnapshot: vi.fn(),
  writeSnapshot: vi.fn(),
  lastSuccessfulSync: vi.fn(),
  loadHealthOverview: vi.fn(),
  loadInsights: vi.fn(),
  loadPortfolio: vi.fn(),
  sendMail: vi.fn(),
  mailerMode: vi.fn(),
  writeAudit: vi.fn(),
  ga4Historical: vi.fn(),
  ga4Traffic: vi.fn(),
  ga4Audience: vi.fn(),
  ga4Pages: vi.fn(),
  ga4Events: vi.fn(),
  ga4Realtime: vi.fn(),
  scQuery: vi.fn(),
  adsenseReport: vi.fn(),
  adManagerReport: vi.fn(),
  adManagerEnabled: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    apiKey: { findUnique: mocks.apiKeyFindUnique, update: mocks.apiKeyUpdate, count: mocks.apiKeyCount },
    website: { findMany: mocks.websiteFindMany, findFirst: mocks.websiteFindFirst, count: mocks.websiteCount },
    organization: { findUnique: mocks.orgFindUnique, delete: mocks.orgDelete, deleteMany: mocks.orgDeleteMany },
    organizationInvite: {
      findFirst: mocks.inviteFindFirst,
      update: mocks.inviteUpdate,
      delete: mocks.inviteDelete,
      count: mocks.inviteCount,
    },
    user: { count: mocks.userCount, update: mocks.userUpdate },
    team: { count: mocks.teamCount },
    googleConnection: { count: mocks.connectionCount },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({
  readSnapshot: mocks.readSnapshot,
  writeSnapshot: mocks.writeSnapshot,
}));
vi.mock("@metricflock/db/health", () => ({ lastSuccessfulSync: mocks.lastSuccessfulSync }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    assertWebsiteAccess: mocks.assertWebsiteAccess,
    getSessionUser: mocks.getSessionUser,
    listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds,
    destroySession: mocks.destroySession,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return {
    ...actual,
    rateLimit: mocks.rateLimit,
    cacheGet: mocks.cacheGet,
    cacheSet: mocks.cacheSet,
    getRedis: mocks.getRedis,
  };
});
vi.mock("@metricflock/google/client", () => ({
  resolveConnectionForWebsite: mocks.resolveConnection,
  getPrimaryIntegration: mocks.getPrimaryIntegration,
  getAuthorizedClientForIntegration: mocks.getAuthorizedClient,
}));
vi.mock("@metricflock/google/ga4", () => ({
  getGa4Client: () => ({}),
  runHistoricalReport: mocks.ga4Historical,
  runTrafficAcquisition: mocks.ga4Traffic,
  runAudienceReport: mocks.ga4Audience,
  runPagesReport: mocks.ga4Pages,
  runEventsReport: mocks.ga4Events,
  runRealtimeReport: mocks.ga4Realtime,
}));
vi.mock("@metricflock/google/search-console", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/google/search-console")>();
  return { ...actual, querySearchAnalytics: mocks.scQuery };
});
vi.mock("@metricflock/google/adsense", () => ({ runAdSenseReport: mocks.adsenseReport }));
vi.mock("@metricflock/google/ad-manager", () => ({
  runAdManagerReport: mocks.adManagerReport,
  adManagerEnabled: mocks.adManagerEnabled,
}));
vi.mock("@/lib/health", () => ({ loadHealthOverview: mocks.loadHealthOverview }));
vi.mock("@/lib/insights", () => ({ loadInsights: mocks.loadInsights }));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));
vi.mock("@metricflock/auth/mailer", () => ({
  sendMail: mocks.sendMail,
  mailerMode: mocks.mailerMode,
}));

import { generateApiKey } from "@metricflock/shared";

// A-DB-05: invites/accept runs the move in an interactive transaction;
// the tx mock executes callback args with this fake client (array-form
// callers still get [] as before).
const fakeTx = {
  $queryRaw: mocks.txQueryRaw,
  user: { count: mocks.userCount, update: mocks.userUpdate },
  team: { count: mocks.teamCount },
  website: { count: mocks.websiteCount },
  googleConnection: { count: mocks.connectionCount },
  apiKey: { count: mocks.apiKeyCount },
  organizationInvite: { count: mocks.inviteCount, update: mocks.inviteUpdate },
};
import { GET as v1Health } from "@/app/api/v1/health/route";
import { GET as v1Insights } from "@/app/api/v1/insights/route";
import { GET as v1Portfolio } from "@/app/api/v1/portfolio/route";
import { GET as v1Websites } from "@/app/api/v1/websites/route";
import { GET as v1WebsiteAnalytics } from "@/app/api/v1/websites/[id]/analytics/route";
import { GET as analyticsOverview } from "@/app/api/analytics/overview/route";
import { GET as analyticsTraffic } from "@/app/api/analytics/traffic/route";
import { GET as analyticsAudience } from "@/app/api/analytics/audience/route";
import { GET as analyticsPages } from "@/app/api/analytics/pages/route";
import { GET as analyticsEvents } from "@/app/api/analytics/events/route";
import { GET as analyticsRealtime } from "@/app/api/analytics/realtime/route";
import { GET as analyticsSearchConsole } from "@/app/api/analytics/search-console/route";
import { GET as analyticsAdsense } from "@/app/api/analytics/adsense/route";
import { GET as analyticsAdManager } from "@/app/api/analytics/ad-manager/route";
import { GET as insightsGet } from "@/app/api/insights/route";
import { GET as integrationsHealthGet } from "@/app/api/integrations/health/route";
import { POST as sendTestPost } from "@/app/api/reports/send-test/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as inviteAcceptPost } from "@/app/api/invites/accept/route";
import { DELETE as inviteRevokeDelete } from "@/app/api/members/invite/[id]/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const healthOverview = {
  summary: { healthy: 1, error: 0, stale: 0, withoutRecord: 0 },
  rows: [],
  total: 0,
  page: 1,
  pageCount: 1,
};
const portfolioResult = {
  totals: { sessions: 42 },
  totalsNote: null,
  websiteCount: 1,
  websites: [{ websiteId: "w1", name: "Site", domain: "site.example", snapshotUpdatedAt: "2026-11-23", stale: false }],
  unavailableWebsites: [],
  truncated: false,
};
const insightsResult = {
  range: { startDate: "2026-10-26", endDate: "2026-11-22" },
  summary: {
    totalEarnings: null,
    blendedPageRpm: null,
    earningsPerThousandSessions: null,
    strikingDistanceQueries: 0,
    lowCtrQueries: 0,
  },
  websites: [],
};

const apiKeyReq = (url: string, key?: string) =>
  new NextRequest(url, key ? { headers: { authorization: `Bearer ${key}` } } : {});
const unauthApiKey = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });

beforeEach(() => {
  vi.clearAllMocks();
  // API-key auth: valid key for org1.
  mocks.apiKeyFindUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: null });
  mocks.apiKeyUpdate.mockResolvedValue({});
  // A-SEC-20: the invite-accept shell check counts live API keys and
  // outstanding invites — default to none (empty shell).
  mocks.apiKeyCount.mockResolvedValue(0);
  mocks.inviteCount.mockResolvedValue(0);
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  // Session auth: signed-in SUPER_ADMIN.
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.getSessionUser.mockResolvedValue(admin);
  mocks.assertWebsiteAccess.mockResolvedValue({ id: "w1", organizationId: "org1", teamId: "t1" });
  mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
  // Analytics pipeline: connected, mapped, no cache/snapshot → live fetch.
  mocks.resolveConnection.mockResolvedValue({ status: "connected" });
  mocks.getPrimaryIntegration.mockResolvedValue({ externalId: "prop-1" });
  mocks.getAuthorizedClient.mockResolvedValue({ auth: {} });
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
  mocks.getRedis.mockReturnValue(null);
  mocks.readSnapshot.mockResolvedValue(null);
  mocks.writeSnapshot.mockResolvedValue(undefined);
  mocks.lastSuccessfulSync.mockResolvedValue(null);
  mocks.ga4Historical.mockResolvedValue({ rows: [{ sessions: 7 }] });
  mocks.ga4Traffic.mockResolvedValue({ rows: [{ sessions: 7 }] });
  mocks.ga4Audience.mockResolvedValue({ rows: [{ users: 5 }] });
  mocks.ga4Pages.mockResolvedValue({ rows: [{ page: "/x", sessions: 3 }] });
  mocks.ga4Events.mockResolvedValue({ rows: [{ event: "click", count: 2 }] });
  mocks.ga4Realtime.mockResolvedValue({ activeUsers: 3, eventCount: 9 });
  mocks.scQuery.mockResolvedValue({ rows: [{ query: "q", clicks: 1 }] });
  mocks.adsenseReport.mockResolvedValue({ rows: [{ earnings: 1.5 }] });
  mocks.adManagerReport.mockResolvedValue({ rows: [{ revenue: 2 }] });
  mocks.adManagerEnabled.mockReturnValue(true);
  mocks.loadHealthOverview.mockResolvedValue(healthOverview);
  mocks.loadInsights.mockResolvedValue(insightsResult);
  mocks.loadPortfolio.mockResolvedValue(portfolioResult);
  mocks.sendMail.mockResolvedValue(undefined);
  mocks.mailerMode.mockReturnValue("smtp");
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.orgFindUnique.mockResolvedValue({ name: "Org One" });
  mocks.tx.mockImplementation(async (arg: unknown) => (typeof arg === "function" ? arg(fakeTx) : []));
  mocks.txQueryRaw.mockResolvedValue([]);
  mocks.orgDelete.mockResolvedValue({});
  mocks.orgDeleteMany.mockResolvedValue({ count: 1 });
});

describe("v1 routes (API-key auth)", () => {
  const key = generateApiKey();
  it("GET /api/v1/health: unauthenticated → 401", async () => {
    const res = await v1Health(apiKeyReq("http://localhost/api/v1/health"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });
  it("GET /api/v1/health: valid key → 200 health overview shape", async () => {
    const res = await v1Health(apiKeyReq("http://localhost/api/v1/health?page=1", key));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: { healthy: 1 }, total: 0 });
    expect(mocks.loadHealthOverview).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org1" }), 1);
  });
  it("GET /api/v1/insights: unauthenticated → 401; valid → 200 insights shape", async () => {
    expect((await v1Insights(apiKeyReq("http://localhost/api/v1/insights"))).status).toBe(401);
    const res = await v1Insights(apiKeyReq("http://localhost/api/v1/insights", key));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: { strikingDistanceQueries: 0 } });
  });
  it("GET /api/v1/portfolio: unauthenticated → 401; valid → 200 totals shape", async () => {
    expect((await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio"))).status).toBe(401);
    const res = await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio", key));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "GA4", report: "overview", totals: { sessions: 42 } });
  });
  it("GET /api/v1/portfolio: unknown provider → 400 invalid_provider", async () => {
    const res = await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio?provider=NOPE", key));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_provider" });
  });
  it("GET /api/v1/websites: unauthenticated → 401; valid → 200 org-scoped list", async () => {
    expect((await v1Websites(apiKeyReq("http://localhost/api/v1/websites"))).status).toBe(401);
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1", name: "Site", domain: "site.example" }]);
    const res = await v1Websites(apiKeyReq("http://localhost/api/v1/websites", key));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ websites: [{ id: "w1" }] });
    // Cross-tenant is enforced by the key's org in the where clause.
    expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org1" } }));
  });
  it("GET /api/v1/websites/[id]/analytics: unauthenticated → 401", async () => {
    const res = await v1WebsiteAnalytics(apiKeyReq("http://localhost/api/v1/websites/w1/analytics"), {
      params: Promise.resolve({ id: "w1" }),
    });
    expect(res.status).toBe(401);
  });
  it("GET /api/v1/websites/[id]/analytics: cross-org website → 404", async () => {
    mocks.websiteFindFirst.mockResolvedValue(null);
    const res = await v1WebsiteAnalytics(apiKeyReq("http://localhost/api/v1/websites/w9/analytics", key), {
      params: Promise.resolve({ id: "w9" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "website_not_found" });
  });
  it("GET /api/v1/websites/[id]/analytics: no property mapped → 200 no_property_mapped", async () => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1" });
    mocks.getPrimaryIntegration.mockResolvedValue(null);
    const res = await v1WebsiteAnalytics(apiKeyReq("http://localhost/api/v1/websites/w1/analytics", key), {
      params: Promise.resolve({ id: "w1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "no_property_mapped", websiteId: "w1" });
  });
  it("GET /api/v1/websites/[id]/analytics: snapshot hit → 200 ok with data", async () => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1" });
    mocks.readSnapshot.mockResolvedValue({
      payload: { sessions: 5 },
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await v1WebsiteAnalytics(apiKeyReq("http://localhost/api/v1/websites/w1/analytics", key), {
      params: Promise.resolve({ id: "w1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", data: { sessions: 5 }, report: "overview" });
  });
  it("GET /api/v1/websites/[id]/analytics: no snapshot yet → 200 no_snapshot_yet", async () => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1" });
    const res = await v1WebsiteAnalytics(apiKeyReq("http://localhost/api/v1/websites/w1/analytics", key), {
      params: Promise.resolve({ id: "w1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "no_snapshot_yet" });
  });

  it("GET /api/v1/websites/[id]/analytics: search-console uses the clamped range for key and response (A-GGL-07)", async () => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1" });
    mocks.readSnapshot.mockResolvedValue({
      payload: { totals: { clicks: 5 } },
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await v1WebsiteAnalytics(
      apiKeyReq("http://localhost/api/v1/websites/w1/analytics?report=search-console&range=28d", key),
      { params: Promise.resolve({ id: "w1" }) },
    );
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const expectedStart = fmt(new Date(today.getTime() - 27 * 86400000));
    const expectedEnd = fmt(new Date(today.getTime() - 3 * 86400000));
    // The snapshot lookup hits the key the worker warmed.
    expect(mocks.readSnapshot).toHaveBeenCalledWith(expect.stringContaining(`:${expectedStart}_${expectedEnd}:`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      range: { startDate: expectedStart, endDate: expectedEnd },
    });
  });
});

describe("analytics routes (session auth + shared handler)", () => {
  const cases = [
    { name: "overview", fn: analyticsOverview, path: "/api/analytics/overview" },
    { name: "traffic", fn: analyticsTraffic, path: "/api/analytics/traffic" },
    { name: "audience", fn: analyticsAudience, path: "/api/analytics/audience" },
    { name: "pages", fn: analyticsPages, path: "/api/analytics/pages" },
    { name: "events", fn: analyticsEvents, path: "/api/analytics/events" },
    { name: "realtime", fn: analyticsRealtime, path: "/api/analytics/realtime" },
    { name: "search-console", fn: analyticsSearchConsole, path: "/api/analytics/search-console" },
    { name: "adsense", fn: analyticsAdsense, path: "/api/analytics/adsense" },
    { name: "ad-manager", fn: analyticsAdManager, path: "/api/analytics/ad-manager" },
  ] as const;
  const url = (path: string) => new NextRequest(`http://localhost${path}?websiteId=w1&range=28d`);
  for (const { name, fn, path } of cases) {
    it(`${name}: unauthenticated → 401`, async () => {
      mocks.requireApiAuth.mockResolvedValueOnce(unauthApiKey());
      const res = await fn(url(path));
      expect(res.status).toBe(401);
    });
    it(`${name}: cross-tenant website → 404`, async () => {
      mocks.assertWebsiteAccess.mockRejectedValueOnce(new Error("NOT_FOUND_OR_FORBIDDEN"));
      const res = await fn(url(path));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found_or_forbidden" });
    });
    it(`${name}: valid → 200 live envelope shape`, async () => {
      const res = await fn(url(path));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: "ok", freshness: "live", includedWebsites: ["w1"] });
      expect(body.data).toBeDefined();
    });
  }
  it("overview: unconnected website → 200 not_connected (not an error)", async () => {
    mocks.resolveConnection.mockResolvedValueOnce({ status: "not_connected" });
    const res = await analyticsOverview(url("/api/analytics/overview"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "not_connected", data: null });
  });
  it("traffic: website with no mapped property → 200 missing_data", async () => {
    mocks.getPrimaryIntegration.mockResolvedValueOnce(null);
    const res = await analyticsTraffic(url("/api/analytics/traffic"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "missing_data", data: null });
  });
  it("ad-manager: disabled provider → 503 ad_manager_disabled without calling auth (A-API-10)", async () => {
    mocks.adManagerEnabled.mockReturnValueOnce(false);
    const res = await analyticsAdManager(url("/api/analytics/ad-manager"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ad_manager_disabled" });
    expect(mocks.requireApiAuth).not.toHaveBeenCalled();
  });
  it("ad-manager: disabled provider → 503 carries the standard error shape (requestId)", async () => {
    mocks.adManagerEnabled.mockReturnValueOnce(false);
    const res = await analyticsAdManager(url("/api/analytics/ad-manager"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("ad_manager_disabled");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});

describe("remaining unexercised routes", () => {
  it("GET /api/insights: unauthenticated → 401; valid → 200 insights shape", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await insightsGet(new NextRequest("http://localhost/api/insights"))).status).toBe(401);
    const res = await insightsGet(new NextRequest("http://localhost/api/insights"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: { strikingDistanceQueries: 0 } });
    expect(mocks.loadInsights).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org1" }));
  });
  it("GET /api/integrations/health: unauthenticated → 401; valid → 200 overview shape", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await integrationsHealthGet(new NextRequest("http://localhost/api/integrations/health"))).status).toBe(401);
    const res = await integrationsHealthGet(new NextRequest("http://localhost/api/integrations/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ summary: { healthy: 1 }, total: 0 });
  });
  it("POST /api/reports/send-test: unauthenticated → 401; forbidden → 403; valid → 200 {ok, to}", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauthApiKey());
    expect(
      (await sendTestPost(new NextRequest("http://localhost/api/reports/send-test", { method: "POST" }))).status,
    ).toBe(401);
    mocks.requireApiAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    expect(
      (await sendTestPost(new NextRequest("http://localhost/api/reports/send-test", { method: "POST" }))).status,
    ).toBe(403);
    const res = await sendTestPost(new NextRequest("http://localhost/api/reports/send-test", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to: "admin@example.com" });
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", subject: expect.stringContaining("[Test]") }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "report.test_sent" }));
  });
  it("POST /api/auth/logout: valid → 200 ok and forwards the session-clearing cookie", async () => {
    mocks.destroySession.mockResolvedValue(
      new Response(null, {
        headers: { "set-cookie": "better-auth.session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT" },
      }),
    );
    const res = await logoutPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });
  it("POST /api/invites/accept: unauthenticated → 401; invalid input → 400", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    const unauth = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
    expect(unauth.status).toBe(401);
    const bad = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", { method: "POST", body: "{}" }),
    );
    expect(bad.status).toBe(400);
  });
  it("POST /api/invites/accept: unknown/expired invite → 404; email mismatch → 403", async () => {
    mocks.inviteFindFirst.mockResolvedValueOnce(null);
    const missing = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
    expect(missing.status).toBe(404);
    mocks.inviteFindFirst.mockResolvedValue({
      id: "inv1",
      email: "someone-else@example.com",
      organizationId: "org2",
      role: "TEAM_MEMBER",
    });
    const mismatch = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
    expect(mismatch.status).toBe(403);
  });
  it("POST /api/invites/accept: empty-shell account moves orgs → 200 ok", async () => {
    mocks.getSessionUser.mockResolvedValue({ ...admin, email: "new@example.com", role: "TEAM_MEMBER" });
    mocks.inviteFindFirst.mockResolvedValue({
      id: "inv1",
      email: "new@example.com",
      organizationId: "org2",
      role: "TEAM_MEMBER",
    });
    mocks.userCount.mockResolvedValue(1);
    mocks.teamCount.mockResolvedValue(0);
    mocks.websiteCount.mockResolvedValue(0);
    mocks.connectionCount.mockResolvedValue(0);
    const res = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.tx).toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.invite_accepted" }));
  });
  it("POST /api/invites/accept: account with real data refuses to move → 409", async () => {
    mocks.getSessionUser.mockResolvedValue({ ...admin, email: "new@example.com", role: "TEAM_MEMBER" });
    mocks.inviteFindFirst.mockResolvedValue({
      id: "inv1",
      email: "new@example.com",
      organizationId: "org2",
      role: "TEAM_MEMBER",
    });
    mocks.teamCount.mockResolvedValue(1);
    const res = await inviteAcceptPost(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({ token: "tok" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_in_organization" });
  });
  it("DELETE /api/members/invite/[id]: unauthenticated → 401; cross-org → 404; valid → 200", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauthApiKey());
    const delCtx = { params: Promise.resolve({ id: "inv1" }) };
    expect(
      (
        await inviteRevokeDelete(
          new NextRequest("http://localhost/api/members/invite/inv1", { method: "DELETE" }),
          delCtx,
        )
      ).status,
    ).toBe(401);
    mocks.inviteFindFirst.mockResolvedValueOnce(null);
    expect(
      (
        await inviteRevokeDelete(
          new NextRequest("http://localhost/api/members/invite/inv1", { method: "DELETE" }),
          delCtx,
        )
      ).status,
    ).toBe(404);
    mocks.inviteFindFirst.mockResolvedValue({ id: "inv1", organizationId: "org1", email: "x@example.com" });
    mocks.inviteDelete.mockResolvedValue({});
    const res = await inviteRevokeDelete(
      new NextRequest("http://localhost/api/members/invite/inv1", { method: "DELETE" }),
      delCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.invite_revoked", entityId: "inv1" }),
    );
  });
});
