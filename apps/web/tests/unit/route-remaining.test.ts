import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: small leftovers — the 1-statement files
// (health, auth/[...all]) and the last uncovered branches of
// invites/accept, v1 analytics/portfolio, reports/send-test,
// integrations/health and insights.
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireApiAuth: vi.fn(),
  writeAudit: vi.fn(),
  apiKeyFindUnique: vi.fn(),
  apiKeyUpdate: vi.fn(),
  rateLimit: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteUpdate: vi.fn(),
  orgDelete: vi.fn(),
  orgFindUnique: vi.fn(),
  tx: vi.fn(),
  userCount: vi.fn(),
  teamCount: vi.fn(),
  websiteCount: vi.fn(),
  connectionCount: vi.fn(),
  websiteFindFirst: vi.fn(),
  getPrimaryIntegration: vi.fn(),
  readSnapshot: vi.fn(),
  loadPortfolio: vi.fn(),
  loadHealthOverview: vi.fn(),
  sendMail: vi.fn(),
  mailerMode: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    apiKey: { findUnique: mocks.apiKeyFindUnique, update: mocks.apiKeyUpdate },
    organizationInvite: { findFirst: mocks.inviteFindFirst, update: mocks.inviteUpdate },
    organization: { findUnique: mocks.orgFindUnique, delete: mocks.orgDelete },
    website: { findFirst: mocks.websiteFindFirst, count: mocks.websiteCount },
    user: { count: mocks.userCount },
    team: { count: mocks.teamCount },
    googleConnection: { count: mocks.connectionCount },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshot: mocks.readSnapshot }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, getSessionUser: mocks.getSessionUser, requireApiAuth: mocks.requireApiAuth };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegration: mocks.getPrimaryIntegration }));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));
vi.mock("@/lib/health", () => ({ loadHealthOverview: mocks.loadHealthOverview }));
vi.mock("@metricflock/auth/mailer", () => ({ sendMail: mocks.sendMail, mailerMode: mocks.mailerMode }));

import { GET as healthGet } from "@/app/api/health/route";
import { GET as allGet, POST as allPost } from "@/app/api/auth/[...all]/route";
import { POST as inviteAcceptPost } from "@/app/api/invites/accept/route";
import { GET as v1AnalyticsGet } from "@/app/api/v1/websites/[id]/analytics/route";
import { GET as v1PortfolioGet } from "@/app/api/v1/portfolio/route";
import { POST as sendTestPost } from "@/app/api/reports/send-test/route";
import { GET as integrationsHealthGet } from "@/app/api/integrations/health/route";
import { GET as insightsGet } from "@/app/api/insights/route";
import { generateApiKey } from "@metricflock/shared";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const apiKeyReq = (url: string, key?: string) =>
  new NextRequest(url, key ? { headers: { authorization: `Bearer ${key}` } } : {});
const jsonReq = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const portfolioResult = {
  totals: { sessions: 42 },
  totalsNote: null,
  websiteCount: 1,
  websites: [{ websiteId: "w1", name: "Site", domain: "site.example", snapshotUpdatedAt: "2026-11-23", stale: false }],
  unavailableWebsites: [],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiKeyFindUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: null });
  mocks.apiKeyUpdate.mockResolvedValue({});
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.getSessionUser.mockResolvedValue(admin);
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.tx.mockImplementation(async (arg: unknown) => (Array.isArray(arg) ? [] : arg));
  mocks.orgFindUnique.mockResolvedValue({ name: "Org One" });
  mocks.loadPortfolio.mockResolvedValue(portfolioResult);
  mocks.loadHealthOverview.mockResolvedValue({
    summary: { healthy: 1, error: 0, stale: 0, withoutRecord: 0 },
    rows: [],
    total: 0,
    page: 1,
    pageCount: 1,
  });
  mocks.sendMail.mockResolvedValue(undefined);
  mocks.mailerMode.mockReturnValue("smtp");
});

describe("GET /api/health", () => {
  it("returns ok + timestamp (liveness, no dependency checks)", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("string");
  });
});

describe("auth/[...all] mount point", () => {
  it("re-exports better-auth GET + POST handlers", () => {
    expect(typeof allGet).toBe("function");
    expect(typeof allPost).toBe("function");
  });
});

describe("POST /api/invites/accept (already-member branch)", () => {
  it("invite for the org the user is already in → 200 alreadyMember", async () => {
    mocks.inviteFindFirst.mockResolvedValue({
      id: "inv1",
      email: "admin@example.com",
      organizationId: "org1",
      role: "TEAM_MEMBER",
    });
    mocks.inviteUpdate.mockResolvedValue({});
    const res = await inviteAcceptPost(jsonReq("http://localhost/api/invites/accept", { token: "tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", alreadyMember: true });
    expect(mocks.inviteUpdate).toHaveBeenCalledWith({
      where: { id: "inv1" },
      data: { acceptedAt: expect.any(Date) },
    });
    expect(mocks.tx).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/websites/[id]/analytics (remaining branches)", () => {
  const key = generateApiKey();
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  it("unknown report → 400 invalid_report", async () => {
    const res = await v1AnalyticsGet(
      apiKeyReq("http://localhost/api/v1/websites/w1/analytics?report=NOPE", key),
      ctx("w1"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_report" });
  });
  it("stale snapshot → 200 ok with stale: true", async () => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1" });
    mocks.getPrimaryIntegration.mockResolvedValue({ externalId: "properties/123" });
    mocks.readSnapshot.mockResolvedValue({
      payload: { sessions: 5 },
      updatedAt: new Date(Date.now() - 3600_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await v1AnalyticsGet(apiKeyReq("http://localhost/api/v1/websites/w1/analytics", key), ctx("w1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", data: { sessions: 5 }, stale: true });
  });
});

describe("GET /api/v1/portfolio (remaining branch)", () => {
  const key = generateApiKey();
  it("report not in the provider's list → 400 invalid_report", async () => {
    const res = await v1PortfolioGet(apiKeyReq("http://localhost/api/v1/portfolio?provider=GA4&report=adsense", key));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_report" });
    expect(mocks.loadPortfolio).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/send-test (mail failure branch)", () => {
  it("sendMail throws → 200 {ok: false} (audit still records delivered: false)", async () => {
    mocks.sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await sendTestPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, to: "admin@example.com" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "report.test_sent",
        details: expect.objectContaining({ delivered: false }),
      }),
    );
  });
});

describe("forbidden branches (role without analytics.view)", () => {
  it("GET /api/integrations/health: no permission → 403", async () => {
    mocks.getSessionUser.mockResolvedValue({ ...admin, role: undefined });
    const res = await integrationsHealthGet(new NextRequest("http://localhost/api/integrations/health"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(mocks.loadHealthOverview).not.toHaveBeenCalled();
  });
  it("GET /api/insights: no permission → 403", async () => {
    mocks.getSessionUser.mockResolvedValue({ ...admin, role: undefined });
    const res = await insightsGet();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });
});
