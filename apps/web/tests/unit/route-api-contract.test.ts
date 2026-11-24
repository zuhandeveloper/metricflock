import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A-API-02/03/04 regression tests (Stage 3): the API error contract.
// - every error response carries a requestId (A-API-02), including on
//   routes that previously bypassed withApiErrors (teams GET);
// - invalid status / range are rejected with 400, never 500 or silent
//   coercion (A-API-03);
// - a failed audit write never turns a successful mutation into a 500
//   (A-API-04; teams POST with a rejecting writeAudit still returns 201).
const mocks = vi.hoisted(() => ({
  teamFindMany: vi.fn(),
  teamCount: vi.fn(),
  teamCreate: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteCount: vi.fn(),
  requireApiAuth: vi.fn(),
  requireApiKey: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  writeAudit: vi.fn(),
  loadPortfolio: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    team: { findMany: mocks.teamFindMany, count: mocks.teamCount, create: mocks.teamCreate },
    website: { findMany: mocks.websiteFindMany, count: mocks.websiteCount },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual };
});
vi.mock("@/lib/api-key-auth", () => ({ requireApiKey: mocks.requireApiKey }));
vi.mock("@/lib/portfolio", () => ({ loadPortfolio: mocks.loadPortfolio }));

import { GET as teamsGet, POST as teamsPost } from "@/app/api/teams/route";
import { GET as websitesGet } from "@/app/api/websites/route";
import { GET as v1Portfolio } from "@/app/api/v1/portfolio/route";
import { resolveRange } from "@/lib/analytics-response";
import { ApiError } from "@/lib/api-error";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const sessionReq = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(url, init);
const apiKeyReq = (url: string) => new NextRequest(url, { headers: { authorization: "Bearer mf_test_key" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.requireApiKey.mockResolvedValue({ user: admin });
  mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.loadPortfolio.mockResolvedValue({
    totals: { sessions: 42 },
    totalsNote: null,
    websiteCount: 1,
    websites: [{ websiteId: "w1" }],
    unavailableWebsites: [],
    truncated: false,
  });
});

describe("A-API-02: every error carries a requestId", () => {
  it("teams GET (previously unwrapped) returns 500 with requestId when Prisma throws", async () => {
    mocks.teamFindMany.mockRejectedValue(new Error("db down"));
    mocks.teamCount.mockResolvedValue(0);
    const res = await teamsGet(sessionReq("http://localhost/api/teams"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error", requestId: expect.any(String) });
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });
  it("teams GET still returns the list on success", async () => {
    mocks.teamFindMany.mockResolvedValue([{ id: "t1", name: "Eng" }]);
    mocks.teamCount.mockResolvedValue(1);
    const res = await teamsGet(sessionReq("http://localhost/api/teams"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pagination: { total: 1 } });
  });
});

describe("A-API-03: invalid inputs are 400, never 500 or silent coercion", () => {
  it("websites GET rejects an unknown status with 400 invalid_status", async () => {
    const res = await websitesGet(sessionReq("http://localhost/api/websites?status=BOGUS"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: "invalid_status",
      details: expect.objectContaining({ status: "BOGUS" }),
      requestId: expect.any(String),
    });
    expect(mocks.websiteFindMany).not.toHaveBeenCalled();
  });
  it("websites GET accepts a valid status", async () => {
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.websiteCount.mockResolvedValue(0);
    const res = await websitesGet(sessionReq("http://localhost/api/websites?status=ACTIVE"));
    expect(res.status).toBe(200);
    expect(mocks.websiteFindMany).toHaveBeenCalled();
  });
  it("v1 portfolio rejects an unknown range with 400 invalid_range", async () => {
    const res = await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio?range=bogus"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_range", details: expect.any(Object), requestId: expect.any(String) });
    expect(mocks.loadPortfolio).not.toHaveBeenCalled();
  });
  it("v1 portfolio rejects range=custom without both dates with 400", async () => {
    const res = await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio?range=custom"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_range");
  });
  it("v1 portfolio accepts a valid range", async () => {
    const res = await v1Portfolio(apiKeyReq("http://localhost/api/v1/portfolio?range=7d"));
    expect(res.status).toBe(200);
    expect(mocks.loadPortfolio).toHaveBeenCalled();
  });
  it("resolveRange throws ApiError(400) on unknown range or custom without dates", () => {
    expect(() => resolveRange("bogus")).toThrowError(ApiError);
    try {
      resolveRange("bogus");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("invalid_range");
      expect((e as ApiError).status).toBe(400);
    }
    expect(() => resolveRange("custom")).toThrowError(ApiError);
    expect(() => resolveRange("custom", "2026-11-01")).toThrowError(ApiError);
    expect(resolveRange("custom", "2026-11-01", "2026-11-22")).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-22",
    });
    expect(resolveRange("7d").startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("A-API-04: a failed audit write never fails the mutation", () => {
  it("teams POST still returns 201 when writeAudit rejects", async () => {
    mocks.teamCreate.mockResolvedValue({ id: "t1", name: "Engineering", slug: "engineering" });
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await teamsPost(
      sessionReq("http://localhost/api/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Engineering", slug: "engineering" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.team).toMatchObject({ id: "t1", name: "Engineering" });
  });
});
