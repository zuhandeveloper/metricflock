import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// A-SEC-05 / A-SEC-07 / A-API-05 (Stage 3, fix #2): the authenticated
// rate limit (per user + route) and the trust-gated client IP.
// No REDIS_URL in the unit-test env → the in-memory fallback path runs;
// the Redis Lua path is exercised in CI smoke (real Redis).
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  teamFindMany: vi.fn(),
  teamCount: vi.fn(),
  loadPortfolio: vi.fn(),
}));

// The real requireApiAuth loads its session user from the auth server
// module (relative import inside the package) — mock that module, not
// the "@metricflock/auth" index, so the real auth + limiter run.
vi.mock("../../../../packages/auth/src/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../packages/auth/src/server")>();
  return { ...actual, getSessionUser: mocks.getSessionUser };
});
vi.mock("@metricflock/db", () => ({
  prisma: {
    team: { findMany: mocks.teamFindMany, count: mocks.teamCount },
  },
}));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));

import { clientIpFromHeaders, isProxyTrusted, normalizeRateLimitPath, authedRateLimitKey } from "@metricflock/shared";
import { requireApiAuth, requireAuthedRateLimit } from "@metricflock/auth";
import { GET as teamsGet } from "@/app/api/teams/route";
import { GET as analyticsOverview } from "@/app/api/analytics/overview/route";

const user = (id: string) => ({
  id,
  organizationId: "org1",
  role: "SUPER_ADMIN",
  email: "admin@example.com",
});
const req = (url: string) => new NextRequest(url);
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
  vi.unstubAllEnvs();
  mocks.teamFindMany.mockResolvedValue([]);
  mocks.teamCount.mockResolvedValue(0);
  mocks.loadPortfolio.mockResolvedValue(portfolioResult);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientIpFromHeaders trust modes (A-SEC-05)", () => {
  const spoofed = () => new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7, 203.0.113.9" });

  it("ignores spoofed headers when no proxy is trusted", () => {
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("VERCEL", "");
    expect(isProxyTrusted()).toBe(false);
    expect(clientIpFromHeaders(spoofed())).toBe("unknown");
  });

  it("trusts headers with explicit TRUST_PROXY=1", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    vi.stubEnv("VERCEL", "");
    expect(isProxyTrusted()).toBe(true);
    expect(clientIpFromHeaders(spoofed())).toBe("203.0.113.9");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }))).toBe("198.51.100.7");
  });

  it("auto-trusts on Vercel (VERCEL=1 is set by the platform)", () => {
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("VERCEL", "1");
    expect(isProxyTrusted()).toBe(true);
    expect(clientIpFromHeaders(spoofed())).toBe("203.0.113.9");
  });

  it("explicit TRUST_PROXY=0 wins over Vercel auto-trust", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    vi.stubEnv("VERCEL", "1");
    expect(isProxyTrusted()).toBe(false);
    expect(clientIpFromHeaders(spoofed())).toBe("unknown");
  });

  it("a spoofed header cannot mint a fresh bucket when untrusted", async () => {
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("VERCEL", "");
    // Both requests key on "unknown" — the second spoofed IP does not
    // reset the login bucket (audit regression case).
    const { rateLimit } = await import("@metricflock/shared");
    const key = `login:${clientIpFromHeaders(spoofed())}`;
    expect(await rateLimit(key, 1, 60_000)).toEqual({ allowed: true, remaining: 0 });
    const otherSpoof = new Headers({ "x-real-ip": "192.0.2.55" });
    expect(clientIpFromHeaders(otherSpoof)).toBe("unknown");
    expect((await rateLimit(`login:${clientIpFromHeaders(otherSpoof)}`, 1, 60_000)).allowed).toBe(false);
  });
});

describe("authed rate-limit keys (A-SEC-07)", () => {
  it("collapses cuid/UUID segments so ids cannot mint buckets", () => {
    expect(normalizeRateLimitPath("/api/teams/cm1234567890abcdefghij")).toBe("/api/teams/{id}");
    expect(normalizeRateLimitPath("/api/websites/550e8400-e29b-41d4-a716-446655440000/transfer")).toBe(
      "/api/websites/{id}/transfer",
    );
    expect(normalizeRateLimitPath("/api/analytics/overview")).toBe("/api/analytics/overview");
    expect(normalizeRateLimitPath("/api/teams")).toBe("/api/teams");
  });

  it("keys per user + route template", () => {
    expect(authedRateLimitKey("u1", "/api/teams/cm1234567890abcdefghij")).toBe("authed:u1:/api/teams/{id}");
    expect(authedRateLimitKey("u1", "/api/teams")).not.toBe(authedRateLimitKey("u2", "/api/teams"));
    expect(authedRateLimitKey("u1", "/api/teams")).not.toBe(authedRateLimitKey("u1", "/api/websites"));
  });
});

describe("requireAuthedRateLimit", () => {
  it("allows up to the default limit, then 429s with rate_limited", async () => {
    const u = user(`u-default-${Math.random()}`);
    const r = req("http://localhost/api/teams");
    for (let i = 0; i < 60; i++) expect(await requireAuthedRateLimit(r, u)).toEqual({ ok: true });
    const denied = await requireAuthedRateLimit(r, u);
    expect("error" in denied).toBe(true);
    if ("error" in denied) {
      expect(denied.error.status).toBe(429);
      expect(await denied.error.json()).toMatchObject({ error: "rate_limited" });
    }
  });

  it("strict tier is lower than default", async () => {
    const u = user(`u-strict-${Math.random()}`);
    const r = req("http://localhost/api/analytics/overview");
    for (let i = 0; i < 20; i++) expect(await requireAuthedRateLimit(r, u, "strict")).toEqual({ ok: true });
    const denied = await requireAuthedRateLimit(r, u, "strict");
    expect("error" in denied).toBe(true);
    if ("error" in denied) expect(denied.error.status).toBe(429);
  });

  it("buckets are independent per user and per route", async () => {
    const a = user(`u-a-${Math.random()}`);
    const b = user(`u-b-${Math.random()}`);
    const teams = req("http://localhost/api/teams");
    const websites = req("http://localhost/api/websites");
    for (let i = 0; i < 60; i++) await requireAuthedRateLimit(teams, a);
    expect(await requireAuthedRateLimit(teams, a)).not.toEqual({ ok: true });
    expect(await requireAuthedRateLimit(teams, b)).toEqual({ ok: true });
    expect(await requireAuthedRateLimit(websites, a)).toEqual({ ok: true });
  });
});

describe("requireApiAuth applies the limit (route-level)", () => {
  it("a previously unprotected route 429s after 60 calls (GET /api/teams)", async () => {
    const u = user(`u-teams-${Math.random()}`);
    mocks.getSessionUser.mockResolvedValue(u);
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const res = await teamsGet(req("http://localhost/api/teams"));
      lastStatus = res.status;
      if (i < 60) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
    const res = await teamsGet(req("http://localhost/api/teams"));
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
  });

  it("an analytics route 429s after 20 calls (strict tier)", async () => {
    const u = user(`u-analytics-${Math.random()}`);
    mocks.getSessionUser.mockResolvedValue(u);
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await analyticsOverview(req("http://localhost/api/analytics/overview?range=28d"));
      lastStatus = res.status;
      if (i < 20) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  });

  it("legitimate traffic well under the limit still passes", async () => {
    const u = user(`u-legit-${Math.random()}`);
    mocks.getSessionUser.mockResolvedValue(u);
    for (let i = 0; i < 5; i++) {
      expect((await teamsGet(req("http://localhost/api/teams"))).status).toBe(200);
      expect((await analyticsOverview(req("http://localhost/api/analytics/overview?range=28d"))).status).toBe(200);
    }
  });

  it("unauthenticated callers still get 401, not 429", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const res = await teamsGet(req("http://localhost/api/teams"));
    expect(res.status).toBe(401);
  });

  it("requireApiAuth itself enforces the limit when req is passed", async () => {
    const u = user(`u-auth-${Math.random()}`);
    mocks.getSessionUser.mockResolvedValue(u);
    const r = req("http://localhost/api/teams");
    for (let i = 0; i < 60; i++) expect(await requireApiAuth("team.view", { req: r })).toEqual({ user: u });
    const denied = await requireApiAuth("team.view", { req: r });
    expect("error" in denied).toBe(true);
    if ("error" in denied) expect(denied.error.status).toBe(429);
  });
});
