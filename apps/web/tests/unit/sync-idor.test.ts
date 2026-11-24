import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  groupBy: vi.fn(),
  update: vi.fn(),
  enqueue: vi.fn(),
  getQueue: vi.fn(),
  counterSnapshot: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@metricflock/auth", () => ({ requireApiAuth: mocks.requireApiAuth }));
vi.mock("@metricflock/db", () => ({
  prisma: {
    analyticsSyncJob: {
      count: mocks.count,
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      groupBy: mocks.groupBy,
      update: mocks.update,
    },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/jobs", () => ({
  enqueue: mocks.enqueue,
  QUEUE_BY_SYNC_TYPE: { GA4_HISTORICAL: "ga4-historical" },
  JOB_PRIORITY: { REQUEUE: 10 },
  getQueue: mocks.getQueue,
  QUEUE_NAMES: [],
}));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, counterSnapshot: mocks.counterSnapshot };
});

import { syncJobOrgWhere } from "@/lib/sync-scope";
import { GET as listFailed } from "@/app/api/sync/failed/route";
import { POST as requeue } from "@/app/api/sync/requeue/route";
import { GET as metrics } from "@/app/api/metrics/route";

const userA = { id: "u-a", organizationId: "org-a", role: "SUPER_ADMIN" };
const userB = { id: "u-b", organizationId: "org-b", role: "SUPER_ADMIN" };
const failedJobA = {
  id: "job-a",
  websiteId: "w-a",
  type: "GA4_HISTORICAL",
  status: "FAILED",
  attempts: 5,
  lastError: "boom",
  payload: { websiteId: "w-a" },
  updatedAt: new Date(),
};
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(url, init);

// A-SEC-01: DLQ + metrics must be scoped to the caller's organization
// (joined via website). With mocked Prisma the assertions are on the
// query itself: the where clause must carry the caller's org, a foreign
// job must be invisible (404/empty), and websiteId = null rows — which
// the relation filter can never match — are visible to no tenant.
describe("syncJobOrgWhere", () => {
  it("scopes through the website relation (null-website rows match no tenant)", () => {
    expect(syncJobOrgWhere("org-a")).toEqual({ website: { organizationId: "org-a" } });
  });
});

describe("GET /api/sync/failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("lists only the caller's org jobs", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userA });
    mocks.count.mockResolvedValue(1);
    mocks.findMany.mockResolvedValue([failedJobA]);
    const res = await listFailed(req("http://localhost/api/sync/failed"));
    expect(res.status).toBe(200);
    expect(mocks.count).toHaveBeenCalledWith({
      where: { status: "FAILED", website: { organizationId: "org-a" } },
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "FAILED", website: { organizationId: "org-a" } } }),
    );
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe("job-a");
  });

  it("returns an empty DLQ for an org with no failed jobs (org B cannot see org A's jobs)", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userB });
    mocks.count.mockResolvedValue(0);
    mocks.findMany.mockResolvedValue([]);
    const res = await listFailed(req("http://localhost/api/sync/failed"));
    expect(res.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "FAILED", website: { organizationId: "org-b" } } }),
    );
    expect((await res.json()).jobs).toEqual([]);
  });
});

describe("POST /api/sync/requeue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue({ id: "bull-1" });
    mocks.update.mockResolvedValue({ ...failedJobA, status: "PENDING" });
  });

  it("requeues the caller's own failed job", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userA });
    mocks.findFirst.mockResolvedValue(failedJobA);
    const res = await requeue(
      req("http://localhost/api/sync/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-a" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "job-a", website: { organizationId: "org-a" } },
    });
    expect(mocks.enqueue).toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-a" }, data: expect.objectContaining({ status: "PENDING" }) }),
    );
  });

  it("returns 404 for a foreign jobId and never enqueues it", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userB });
    mocks.findFirst.mockResolvedValue(null); // scoped lookup finds nothing in org B
    const res = await requeue(
      req("http://localhost/api/sync/requeue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: "job-a" }),
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "job-a", website: { organizationId: "org-b" } },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.counterSnapshot.mockReturnValue({});
    mocks.getQueue.mockReturnValue(undefined);
  });

  it("counts only the caller's org jobs", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userA });
    mocks.groupBy.mockResolvedValue([{ status: "FAILED", _count: { _all: 1 } }]);
    mocks.findFirst.mockResolvedValue({ updatedAt: new Date("2026-11-23T00:00:00Z") });
    const res = await metrics(req("http://localhost/api/metrics"));
    expect(res.status).toBe(200);
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ website: { organizationId: "org-a" } }) }),
    );
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "FAILED", website: { organizationId: "org-a" } } }),
    );
    expect((await res.json()).dlq.failed24h).toBe(1);
  });

  it("reports zero failures for an org with none (no cross-tenant counts)", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: userB });
    mocks.groupBy.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue(null);
    const res = await metrics(req("http://localhost/api/metrics"));
    expect(res.status).toBe(200);
    expect(mocks.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ website: { organizationId: "org-b" } }) }),
    );
    expect((await res.json()).dlq.failed24h).toBe(0);
  });
});
