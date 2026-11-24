import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Worker scheduler (apps/worker/src/scheduler.ts): startScheduler drives
// one tick per minute behind a Redis lock. The tick itself is internal,
// so these tests drive it through startScheduler with a fake Redis
// client and mocked Prisma / BullMQ queue access.
// (The scheduler is imported via the "@metricflock/worker/scheduler"
// package export.)
const mocks = vi.hoisted(() => ({
  websiteFindMany: vi.fn(),
  groupBy: vi.fn(),
  connFindMany: vi.fn(),
  scheduleFindMany: vi.fn(),
  syncJobDeleteMany: vi.fn(),
  oauthStateDeleteMany: vi.fn(),
  cacheDeleteMany: vi.fn(),
  auditDeleteMany: vi.fn(),
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
    analyticsSyncJob: { groupBy: mocks.groupBy, deleteMany: mocks.syncJobDeleteMany },
    googleConnection: { findMany: mocks.connFindMany },
    reportSchedule: { findMany: mocks.scheduleFindMany },
    oAuthState: { deleteMany: mocks.oauthStateDeleteMany },
    analyticsCache: { deleteMany: mocks.cacheDeleteMany },
    auditLog: { deleteMany: mocks.auditDeleteMany },
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

const LOCK_KEY = "metricflock:scheduler:lock";
const DAY_MS = 86_400_000;

function ga4Site(id: string) {
  return { id, integrations: [{ provider: "GA4" }] };
}

describe("worker scheduler", () => {
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
  const queues = () => entries().map((e) => e.name as string);

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
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
    mocks.getQueue.mockReturnValue(null);
    mocks.adManagerEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    for (const s of started) s.stop();
    vi.useRealTimers();
  });

  it("enqueues due syncs for a never-synced GA4 site with realtime priority and stable realtime jobId", async () => {
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
    start();
    await flush();

    expect(mocks.redisSet).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), "PX", 55_000, "NX");
    expect(queues().sort()).toEqual(["ga4-historical-sync", "ga4-realtime-sync", "integration-health-check"]);
    const realtime = entries().find((e) => e.name === "ga4-realtime-sync")!;
    expect(realtime.jobId).toBe("ga4-realtime-sync:site-1:stable");
    expect(realtime.priority).toBe(5); // JOB_PRIORITY.REALTIME
    expect(realtime.data).toEqual({ websiteId: "site-1" });
    expect(typeof realtime.delayMs).toBe("number");
    const historical = entries().find((e) => e.name === "ga4-historical-sync")!;
    expect(historical.priority).toBe(10); // JOB_PRIORITY.SCHEDULED
    expect(historical.jobId).toMatch(/^ga4-historical-sync:site-1:\d+$/);
    // The lock is released with the same token it was acquired with.
    const token = mocks.redisSet.mock.calls[0][1] as string;
    expect(mocks.redisEval).toHaveBeenCalledWith(expect.stringContaining("DEL"), 1, LOCK_KEY, token);
    expect(mocks.logInfo).toHaveBeenCalledWith("tick enqueued jobs", expect.objectContaining({ enqueued: 3 }));
  });

  it("does nothing when another instance holds the lock", async () => {
    mocks.redisSet.mockResolvedValue(null);
    start();
    await flush();

    expect(mocks.enqueueBulk).not.toHaveBeenCalled();
    expect(mocks.websiteFindMany).not.toHaveBeenCalled();
    expect(mocks.redisEval).not.toHaveBeenCalled();
  });

  it("a failed lock acquisition is a failed tick, and the next tick can still run", async () => {
    mocks.redisSet.mockRejectedValueOnce(new Error("redis down"));
    start();
    await flush();

    expect(mocks.incr).toHaveBeenCalledWith("scheduler.tick_failed");
    expect(mocks.logError).toHaveBeenCalledWith("tick failed", expect.anything());
    expect(mocks.enqueueBulk).not.toHaveBeenCalled();
    // tickRunning was reset: the 60s interval tick runs normally.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
  });

  it("a failing lock release does not fail the tick", async () => {
    mocks.redisEval.mockRejectedValueOnce(new Error("redis down"));
    start();
    await flush();

    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(2);
  });

  it("ticks never overlap in-process: a second tick while one runs does not re-acquire", async () => {
    let releaseSet!: (v: string) => void;
    mocks.redisSet.mockImplementationOnce(() => new Promise<string>((resolve) => (releaseSet = resolve)));
    start(); // first tick starts, lock acquisition pending
    await flush();
    start(); // second tick starts while the first is still running
    await flush();

    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    releaseSet("OK");
    await flush();
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
  });

  it("re-ticks on the 60s interval and stops when stopped", async () => {
    const s = start();
    await flush();
    expect(mocks.redisSet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.redisSet).toHaveBeenCalledTimes(2);
  });

  it("respects the last-success lookup: recent realtime is not due, stale historical is", async () => {
    const now = new Date();
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
    mocks.groupBy.mockResolvedValue([
      { websiteId: "site-1", type: "GA4_REALTIME", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
      { websiteId: "site-1", type: "GA4_HISTORICAL", _max: { updatedAt: new Date(now.getTime() - 50 * 60_000) } },
      // A row with no website is ignored by the last-success lookup.
      { websiteId: null, type: "GA4_REALTIME", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
    ]);
    start();
    await flush();

    expect(queues().sort()).toEqual(["ga4-historical-sync", "integration-health-check"]);
  });

  it("paginates websites in 500-site pages with cursor + skip", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ga4Site(`site-${i}`));
    mocks.websiteFindMany.mockResolvedValueOnce(page1).mockResolvedValueOnce([ga4Site("site-500")]);
    start();
    await flush();

    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.websiteFindMany.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(mocks.websiteFindMany.mock.calls[1][0]).toMatchObject({ cursor: { id: "site-499" }, skip: 1 });
    expect(entries()).toHaveLength(501 * 3);
    expect(queues()).toContain("ga4-realtime-sync");
    expect(entries().some((e) => (e.data as { websiteId: string }).websiteId === "site-500")).toBe(true);
  });

  it("skips realtime enqueues under backpressure and keeps them when the depth check fails", async () => {
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
    mocks.getQueue.mockReturnValue({ getJobCounts: mocks.getJobCounts });
    mocks.getJobCounts.mockResolvedValue({ waiting: 30, delayed: 20 }); // depth 50 > 40
    start();
    await flush();

    expect(queues().sort()).toEqual(["ga4-historical-sync", "integration-health-check"]);
    expect(mocks.logWarn).toHaveBeenCalledWith("realtime backpressure: skipping realtime enqueues this tick", {
      depth: 50,
    });
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.realtime_backpressure");

    // getJobCounts rejecting degrades to depth 0: realtime is kept.
    vi.clearAllMocks();
    mocks.redisSet.mockImplementation(async () => "OK");
    mocks.redisEval.mockImplementation(async () => 1);
    mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
    mocks.groupBy.mockResolvedValue([]);
    mocks.connFindMany.mockResolvedValue([]);
    mocks.scheduleFindMany.mockResolvedValue([]);
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
    mocks.getQueue.mockReturnValue({ getJobCounts: mocks.getJobCounts });
    mocks.getJobCounts.mockRejectedValue(new Error("redis down"));
    mocks.adManagerEnabled.mockReturnValue(false);
    start();
    await flush();
    expect(queues()).toContain("ga4-realtime-sync");
  });

  it("backpressure depth treats missing waiting/delayed counts as zero", async () => {
    const setupBackpressure = (counts: Record<string, number>) => {
      vi.clearAllMocks();
      mocks.redisSet.mockImplementation(async () => "OK");
      mocks.redisEval.mockImplementation(async () => 1);
      mocks.websiteFindMany.mockResolvedValue([ga4Site("site-1")]);
      mocks.groupBy.mockResolvedValue([]);
      mocks.connFindMany.mockResolvedValue([]);
      mocks.scheduleFindMany.mockResolvedValue([]);
      mocks.syncJobDeleteMany.mockResolvedValue({ count: 0 });
      mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
      mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
      mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
      mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
      mocks.getQueue.mockReturnValue({ getJobCounts: mocks.getJobCounts });
      mocks.getJobCounts.mockResolvedValue(counts);
      mocks.adManagerEnabled.mockReturnValue(false);
    };

    // Only delayed present: 0 waiting + 45 delayed = 45 > 40, realtime dropped.
    setupBackpressure({ delayed: 45 });
    start();
    await flush();
    expect(queues()).not.toContain("ga4-realtime-sync");
    expect(mocks.logWarn).toHaveBeenCalledWith("realtime backpressure: skipping realtime enqueues this tick", {
      depth: 45,
    });

    // Only waiting present: 45 waiting + 0 delayed = 45 > 40, realtime dropped.
    setupBackpressure({ waiting: 45 });
    start();
    await flush();
    expect(queues()).not.toContain("ga4-realtime-sync");
  });

  it("enqueues OAuth refresh for expiring connections and discovery for undiscovered ones", async () => {
    const now = new Date();
    mocks.connFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
      args.where && "properties" in args.where ? [{ id: "conn-undisc" }] : [{ id: "conn-exp" }],
    );
    start();
    await flush();

    const hourBucket = Math.floor(now.getTime() / 3_600_000);
    const dayBucket = Math.floor(now.getTime() / DAY_MS);
    expect(entries()).toContainEqual({
      name: "google-oauth-refresh",
      data: { connectionId: "conn-exp" },
      jobId: `google-oauth-refresh:conn-exp:${hourBucket}`,
    });
    expect(entries()).toContainEqual({
      name: "google-property-discovery",
      data: { connectionId: "conn-undisc" },
      jobId: `google-property-discovery:conn-undisc:${dayBucket}`,
    });
  });

  it("enqueues a scheduled report only for due schedules", async () => {
    const now = new Date();
    const due = {
      enabled: true,
      dayOfWeek: now.getUTCDay(),
      hourUtc: now.getUTCHours(),
      lastSentAt: null,
      organizationId: "org-1",
    };
    mocks.scheduleFindMany.mockResolvedValue([
      due,
      { ...due, organizationId: "org-2", hourUtc: (now.getUTCHours() + 1) % 24 },
      { ...due, organizationId: "org-3", enabled: false },
      { ...due, organizationId: "org-4", lastSentAt: new Date(now.getTime() - 60_000) },
    ]);
    start();
    await flush();

    const dayBucket = Math.floor(now.getTime() / DAY_MS);
    expect(entries()).toContainEqual({
      name: "scheduled-report",
      data: { organizationId: "org-1" },
      jobId: `scheduled-report:org-1:${dayBucket}`,
    });
    expect(entries().filter((e) => e.name === "scheduled-report")).toHaveLength(1);
  });

  it("includes the Ad Manager queue only when Ad Manager is enabled", async () => {
    mocks.websiteFindMany.mockResolvedValue([{ id: "site-1", integrations: [{ provider: "AD_MANAGER" }] }]);
    mocks.adManagerEnabled.mockReturnValue(true);
    start();
    await flush();
    expect(queues().sort()).toEqual(["ad-manager-sync", "integration-health-check"]);

    vi.clearAllMocks();
    mocks.redisSet.mockImplementation(async () => "OK");
    mocks.redisEval.mockImplementation(async () => 1);
    mocks.websiteFindMany.mockResolvedValue([{ id: "site-1", integrations: [{ provider: "AD_MANAGER" }] }]);
    mocks.groupBy.mockResolvedValue([]);
    mocks.connFindMany.mockResolvedValue([]);
    mocks.scheduleFindMany.mockResolvedValue([]);
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
    mocks.getQueue.mockReturnValue(null);
    mocks.adManagerEnabled.mockReturnValue(false);
    start();
    await flush();
    expect(queues()).toEqual(["integration-health-check"]);
  });

  it("prunes old bookkeeping, OAuth state, cache rows and audit logs with the right cutoffs", async () => {
    const now = new Date();
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 3 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cacheDeleteMany.mockResolvedValue({ count: 2 });
    mocks.auditDeleteMany.mockResolvedValue({ count: 4 });
    start();
    await flush();

    const closeTo = (actual: Date, expectedMs: number) => Math.abs(actual.getTime() - expectedMs) < 5_000;
    const syncWhere = mocks.syncJobDeleteMany.mock.calls[0][0].where as {
      updatedAt: { lt: Date };
      status: { in: string[] };
    };
    expect(closeTo(syncWhere.updatedAt.lt, now.getTime() - 30 * DAY_MS)).toBe(true);
    expect(syncWhere.status.in).toEqual(["SUCCEEDED", "FAILED"]);
    const stateWhere = mocks.oauthStateDeleteMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(stateWhere.expiresAt.lt, now.getTime() - DAY_MS)).toBe(true);
    const cacheWhere = mocks.cacheDeleteMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(cacheWhere.expiresAt.lt, now.getTime())).toBe(true);
    const auditWhere = mocks.auditDeleteMany.mock.calls[0][0].where as { createdAt: { lt: Date } };
    expect(closeTo(auditWhere.createdAt.lt, now.getTime() - 365 * DAY_MS)).toBe(true);
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old sync-job rows", { count: 3 });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired OAuth states", { count: 1 });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired analytics cache rows", { count: 2 });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old audit logs", { count: 4 });
  });

  it("with no work at all, enqueues nothing and logs no tick summary", async () => {
    start();
    await flush();

    expect(mocks.enqueueBulk).toHaveBeenCalledWith([]);
    expect(mocks.logInfo).not.toHaveBeenCalledWith("tick enqueued jobs", expect.anything());
    // Retention still runs even on an empty tick.
    expect(mocks.syncJobDeleteMany).toHaveBeenCalledTimes(1);
  });
});
