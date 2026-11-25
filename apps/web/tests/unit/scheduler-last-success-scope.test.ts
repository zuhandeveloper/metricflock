import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Worker scheduler last-success scoping (A-WRK-05): the tick used to run
// one unscoped groupBy over every SUCCEEDED row in 30 days, every
// minute. The lookup is now scoped per website page (websiteId IN the
// ids of the page just loaded). These tests drive the tick through
// startScheduler with a fake Redis client and mocked Prisma / BullMQ
// queue access, mirroring worker-scheduler.test.ts (which must not be
// edited — it carries the A-WRK-04 tests).
// (The scheduler is imported via the "@metricflock/worker/scheduler"
// package export.)
const mocks = vi.hoisted(() => ({
  websiteFindMany: vi.fn(),
  groupBy: vi.fn(),
  connFindMany: vi.fn(),
  scheduleFindMany: vi.fn(),
  syncJobDeleteMany: vi.fn(),
  syncJobFindMany: vi.fn(),
  syncJobUpdateMany: vi.fn(),
  oauthStateDeleteMany: vi.fn(),
  oauthStateFindMany: vi.fn(),
  cacheDeleteMany: vi.fn(),
  cacheFindMany: vi.fn(),
  auditDeleteMany: vi.fn(),
  auditFindMany: vi.fn(),
  orgFindMany: vi.fn(),
  orgDeleteMany: vi.fn(),
  enqueueBulk: vi.fn(),
  getQueue: vi.fn(),
  getJobCounts: vi.fn(),
  adManagerEnabled: vi.fn(),
  incr: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findMany: mocks.websiteFindMany },
    analyticsSyncJob: {
      groupBy: mocks.groupBy,
      deleteMany: mocks.syncJobDeleteMany,
      findMany: mocks.syncJobFindMany,
      updateMany: mocks.syncJobUpdateMany,
    },
    googleConnection: { findMany: mocks.connFindMany },
    reportSchedule: { findMany: mocks.scheduleFindMany },
    oAuthState: { deleteMany: mocks.oauthStateDeleteMany, findMany: mocks.oauthStateFindMany },
    analyticsCache: { deleteMany: mocks.cacheDeleteMany, findMany: mocks.cacheFindMany },
    auditLog: { deleteMany: mocks.auditDeleteMany, findMany: mocks.auditFindMany },
    organization: { findMany: mocks.orgFindMany, deleteMany: mocks.orgDeleteMany },
  },
}));

vi.mock("@metricflock/jobs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@metricflock/jobs")>();
  return { ...real, enqueueBulk: mocks.enqueueBulk, getQueue: mocks.getQueue };
});

vi.mock("@metricflock/google/ad-manager", () => ({ adManagerEnabled: mocks.adManagerEnabled }));

vi.mock("@metricflock/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@metricflock/shared")>();
  return {
    ...real,
    incr: mocks.incr,
    createLogger: () => ({ info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError }),
  };
});

import { startScheduler } from "@metricflock/worker/scheduler";

const DAY_MS = 86_400_000;

function ga4Site(id: string) {
  return { id, integrations: [{ provider: "GA4" }] };
}

type GroupByArgs = {
  where?: { status?: string; websiteId?: { in?: string[]; not?: null }; updatedAt?: { gte?: Date } };
};

describe("scheduler last-success lookup scoping (A-WRK-05)", () => {
  const started: { stop: () => void }[] = [];
  const fakeRedis = { set: mocks.redisSet, eval: mocks.redisEval } as never;

  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };
  const start = () => {
    const s = startScheduler(fakeRedis);
    started.push(s);
    return s;
  };
  const entries = () => (mocks.enqueueBulk.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[];
  const queuesFor = (websiteId: string) =>
    entries()
      .filter((e) => (e.data as { websiteId: string }).websiteId === websiteId)
      .map((e) => e.name as string)
      .sort();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    started.length = 0;
    mocks.redisSet.mockImplementation(async () => "OK");
    mocks.redisEval.mockImplementation(async () => 1);
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.groupBy.mockResolvedValue([]);
    mocks.connFindMany.mockResolvedValue([]);
    mocks.scheduleFindMany.mockResolvedValue([]);
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 0 });
    mocks.syncJobFindMany.mockResolvedValue([]);
    mocks.syncJobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateFindMany.mockResolvedValue([]);
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheFindMany.mockResolvedValue([]);
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.orgFindMany.mockResolvedValue([]);
    mocks.orgDeleteMany.mockResolvedValue({ count: 0 });
    mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
    mocks.getQueue.mockReturnValue(null);
    mocks.adManagerEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    for (const s of started) s.stop();
    vi.useRealTimers();
  });

  it("scopes the groupBy to the loaded page's website ids (never unscoped)", async () => {
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
    start();
    await flush();

    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
    const args = mocks.groupBy.mock.calls[0][0] as GroupByArgs;
    expect(args.where?.websiteId).toEqual({ in: ["site-1"] });
    expect(args.where?.status).toBe("SUCCEEDED");
    // The 30-day window is unchanged (older successes are "never").
    const gte = args.where?.updatedAt?.gte?.getTime() ?? 0;
    expect(gte).toBeGreaterThanOrEqual(Date.now() - 30 * DAY_MS - 5_000);
    expect(gte).toBeLessThanOrEqual(Date.now() - 30 * DAY_MS + 5_000);
    // No call anywhere in the tick may use the old unscoped shape.
    for (const call of mocks.groupBy.mock.calls) {
      expect((call[0] as GroupByArgs).where?.websiteId).not.toHaveProperty("not");
    }
  });

  it("returns the same due set as the unscoped lookup (seeded fixtures)", async () => {
    const now = new Date();
    const lastSuccessRows = [
      // site-1: realtime succeeded 10 s ago (not due), historical 50 min ago (due).
      { websiteId: "site-1", type: "GA4_REALTIME", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
      { websiteId: "site-1", type: "GA4_HISTORICAL", _max: { updatedAt: new Date(now.getTime() - 50 * 60_000) } },
      // site-99 is not in the website list: the scoped query never sees
      // it, and the old unscoped query's row for it was never read by
      // planDueSyncs either — it must not change the plan. (The
      // null-websiteId guard is pinned by worker-scheduler.test.ts,
      // whose mock returns a null row; a scoped IN-list query never
      // returns one.)
      { websiteId: "site-99", type: "GA4_REALTIME", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
    ];
    // Faithful scoped-query mock: only rows for the requested ids come back.
    mocks.groupBy.mockImplementation(async (args: GroupByArgs) => {
      const ids = args.where?.websiteId?.in ?? [];
      return lastSuccessRows.filter((r) => ids.includes(r.websiteId));
    });
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1"), ga4Site("site-2")]);
    start();
    await flush();

    // site-1: historical due, realtime not due. site-2: never synced, all due.
    expect(queuesFor("site-1")).toEqual(["ga4-historical-sync", "integration-health-check"]);
    expect(queuesFor("site-2")).toEqual(["ga4-historical-sync", "ga4-realtime-sync", "integration-health-check"]);
  });

  it("scopes one groupBy per website page across pages", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ga4Site(`site-${i}`));
    mocks.websiteFindMany.mockResolvedValueOnce(page1).mockResolvedValueOnce([ga4Site("site-500")]);
    start();
    await flush();

    expect(mocks.groupBy).toHaveBeenCalledTimes(2);
    const first = mocks.groupBy.mock.calls[0][0] as GroupByArgs;
    const second = mocks.groupBy.mock.calls[1][0] as GroupByArgs;
    expect(first.where?.websiteId?.in).toHaveLength(500);
    expect(first.where?.websiteId?.in).toContain("site-0");
    expect(first.where?.websiteId?.in).toContain("site-499");
    expect(second.where?.websiteId?.in).toEqual(["site-500"]);
  });

  it("issues no groupBy at all when there are no mapped websites", async () => {
    mocks.websiteFindMany.mockResolvedValue([]);
    start();
    await flush();

    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(0);
  });
});
