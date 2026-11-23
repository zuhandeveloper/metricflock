import { describe, expect, it, vi, beforeEach } from "vitest";
import { deriveHealthState, healthTransition, HEALTH_STALE_AFTER_MS } from "@metricflock/shared";
import { loadHealthOverview } from "@/lib/health";

const mocks = vi.hoisted(() => ({
  healthCount: vi.fn(),
  healthFindMany: vi.fn(),
  integrationCount: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    integrationHealth: { count: mocks.healthCount, findMany: mocks.healthFindMany },
    websiteIntegration: { count: mocks.integrationCount },
  },
}));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));

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
});
