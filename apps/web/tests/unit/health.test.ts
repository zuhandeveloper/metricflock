import { describe, expect, it, vi, beforeEach } from "vitest";
import { deriveHealthState, healthTransition, HEALTH_STALE_AFTER_MS } from "@metricflock/shared";
import { loadHealthOverview } from "@/lib/health";
import { GET as readinessGet } from "@/app/api/health/ready/route";

const mocks = vi.hoisted(() => ({
  healthCount: vi.fn(),
  healthFindMany: vi.fn(),
  integrationCount: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  queryRaw: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    integrationHealth: { count: mocks.healthCount, findMany: mocks.healthFindMany },
    websiteIntegration: { count: mocks.integrationCount },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, getRedis: mocks.getRedis };
});

// Phase 7.2: health-state derivation + transition alerting rules.
describe("deriveHealthState", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  it("error status is error regardless of recency", () => {
    expect(deriveHealthState({ status: "error", lastSuccessAt: now }, now)).toBe("error");
  });
  it("ok with a recent success is healthy", () => {
    expect(deriveHealthState({ status: "ok", lastSuccessAt: new Date(now.getTime() - 1000) }, now)).toBe("healthy");
  });
  it("ok with an old or missing success is stale", () => {
    expect(
      deriveHealthState({ status: "ok", lastSuccessAt: new Date(now.getTime() - HEALTH_STALE_AFTER_MS - 1) }, now),
    ).toBe("stale");
    expect(deriveHealthState({ status: "ok", lastSuccessAt: null }, now)).toBe("stale");
  });
});

describe("healthTransition", () => {
  it("alerts on ok→error and on a first-ever error record", () => {
    expect(healthTransition("ok", "error")).toBe("alert_error");
    expect(healthTransition(null, "error")).toBe("alert_error");
  });
  it("stays silent on repeated errors and repeated ok", () => {
    expect(healthTransition("error", "error")).toBeNull();
    expect(healthTransition("ok", "ok")).toBeNull();
    expect(healthTransition(null, "ok")).toBeNull();
  });
  it("reports recovery on error→ok", () => {
    expect(healthTransition("error", "ok")).toBe("recovered");
  });
});

describe("loadHealthOverview", () => {
  const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.healthCount
      .mockResolvedValueOnce(4) // total
      .mockResolvedValueOnce(1) // error
      .mockResolvedValueOnce(1); // stale
    mocks.integrationCount.mockResolvedValue(5);
    mocks.healthFindMany.mockResolvedValue([
      {
        websiteId: "w1",
        provider: "GA4",
        status: "error",
        lastSuccessAt: null,
        lastError: "CONNECTION_REVOKED",
        checkedAt: new Date("2026-11-22T11:00:00Z"),
        website: { name: "Site One", domain: "one.example" },
      },
    ]);
  });

  it("summarizes states and maps rows", async () => {
    const result = await loadHealthOverview(user, 1);
    expect(result.summary).toEqual({ healthy: 2, error: 1, stale: 1, withoutRecord: 1 });
    expect(result.rows[0]).toMatchObject({ websiteId: "w1", state: "error", provider: "GA4" });
    expect(result.total).toBe(4);
    expect(result.pageCount).toBe(1);
  });

  it("scopes to accessible websites for restricted users", async () => {
    mocks.listAccessibleWebsiteIds.mockResolvedValue(["w1"]);
    await loadHealthOverview({ ...user, role: "TEAM_MEMBER" }, 1);
    expect(mocks.healthFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { website: { organizationId: "org1", id: { in: ["w1"] } } },
      }),
    );
  });

  // A-API-09: an unbounded page used to force a huge skip (page 10⁹ =
  // 50-billion-row skip). The page is clamped to the same offset cap
  // as parsePagination, expressed in 50-row pages (201 pages).
  it("clamps an absurd page to the offset cap", async () => {
    const result = await loadHealthOverview(user, 1_000_000_000);
    expect(result.page).toBe(201);
    expect(mocks.healthFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10_000, take: 50 }));
  });

  it("keeps in-range pages unchanged", async () => {
    const result = await loadHealthOverview(user, 2);
    expect(result.page).toBe(2);
    expect(mocks.healthFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
  });

  // A-COV-11: the two branch fallbacks the suite never exercised —
  // a non-finite page (e.g. NaN from a malformed query param) falls
  // back to page 1, and a website row missing name/domain maps to
  // empty strings instead of crashing the overview.
  it("falls back to page 1 for a non-finite page", async () => {
    const result = await loadHealthOverview(user, Number.NaN);
    expect(result.page).toBe(1);
    expect(mocks.healthFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });

  it("maps a website without name/domain to empty strings", async () => {
    mocks.healthFindMany.mockResolvedValue([
      {
        websiteId: "w9",
        provider: "GA4",
        status: "ok",
        lastSuccessAt: new Date(),
        lastError: null,
        checkedAt: new Date(),
        website: {},
      },
    ]);
    const result = await loadHealthOverview(user, 1);
    expect(result.rows[0]).toMatchObject({ websiteId: "w9", websiteName: "", domain: "", state: "healthy" });
  });
});

// A-LIVE-01 (Stage 1, row 18 — code-side part only): the readiness logic
// reports redis:"disabled" (not a failure) when REDIS_URL is unset, so a
// no-Redis instance is ready; a configured-but-down Redis is 503. The
// production fix itself is operational (restore Redis or remove
// REDIS_URL in Vercel) — this test pins the code behaviour.
describe("GET /api/health/ready", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("reports redis:disabled and 200 ready when REDIS_URL is unset", async () => {
    mocks.getRedis.mockReturnValue(null);
    const res = await readinessGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ready",
      checks: { db: "ok", redis: "disabled" },
    });
  });
  it("reports 503 not_ready when a configured Redis is down (db ok)", async () => {
    mocks.getRedis.mockReturnValue({ ping: async () => "FAIL" });
    const res = await readinessGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      checks: { db: "ok", redis: "down" },
    });
  });
  it("reports 503 not_ready when Redis ping throws", async () => {
    mocks.getRedis.mockReturnValue({
      ping: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const res = await readinessGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "not_ready", checks: { redis: "down" } });
  });
  it("reports 503 not_ready when the database check fails", async () => {
    mocks.getRedis.mockReturnValue(null);
    mocks.queryRaw.mockRejectedValue(new Error("db down"));
    const res = await readinessGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      checks: { db: "down", redis: "disabled" },
    });
  });
});
