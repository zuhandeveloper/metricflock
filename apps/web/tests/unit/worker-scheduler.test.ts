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
  inviteFindMany: vi.fn(),
  inviteDeleteMany: vi.fn(),
  verificationFindMany: vi.fn(),
  verificationDeleteMany: vi.fn(),
  sessionFindMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
  healthFindMany: vi.fn(),
  healthDeleteMany: vi.fn(),
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
    organizationInvite: { findMany: mocks.inviteFindMany, deleteMany: mocks.inviteDeleteMany },
    verification: { findMany: mocks.verificationFindMany, deleteMany: mocks.verificationDeleteMany },
    session: { findMany: mocks.sessionFindMany, deleteMany: mocks.sessionDeleteMany },
    integrationHealth: { findMany: mocks.healthFindMany, deleteMany: mocks.healthDeleteMany },
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
    mocks.inviteFindMany.mockResolvedValue([]);
    mocks.inviteDeleteMany.mockResolvedValue({ count: 0 });
    mocks.verificationFindMany.mockResolvedValue([]);
    mocks.verificationDeleteMany.mockResolvedValue({ count: 0 });
    mocks.sessionFindMany.mockResolvedValue([]);
    mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.healthDeleteMany.mockResolvedValue({ count: 0 });
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
    mocks.syncJobFindMany.mockResolvedValue([]);
    mocks.syncJobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateFindMany.mockResolvedValue([]);
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheFindMany.mockResolvedValue([]);
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditFindMany.mockResolvedValue([]);
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
      mocks.syncJobFindMany.mockResolvedValue([]);
      mocks.syncJobUpdateMany.mockResolvedValue({ count: 0 });
      mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
      mocks.oauthStateFindMany.mockResolvedValue([]);
      mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
      mocks.cacheFindMany.mockResolvedValue([]);
      mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
      mocks.auditFindMany.mockResolvedValue([]);
      mocks.inviteFindMany.mockResolvedValue([]);
      mocks.inviteDeleteMany.mockResolvedValue({ count: 0 });
      mocks.verificationFindMany.mockResolvedValue([]);
      mocks.verificationDeleteMany.mockResolvedValue({ count: 0 });
      mocks.sessionFindMany.mockResolvedValue([]);
      mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
      mocks.healthFindMany.mockResolvedValue([]);
      mocks.healthDeleteMany.mockResolvedValue({ count: 0 });
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
    mocks.syncJobFindMany.mockResolvedValue([]);
    mocks.syncJobUpdateMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oauthStateFindMany.mockResolvedValue([]);
    mocks.cacheDeleteMany.mockResolvedValue({ count: 0 });
    mocks.cacheFindMany.mockResolvedValue([]);
    mocks.auditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.inviteFindMany.mockResolvedValue([]);
    mocks.inviteDeleteMany.mockResolvedValue({ count: 0 });
    mocks.verificationFindMany.mockResolvedValue([]);
    mocks.verificationDeleteMany.mockResolvedValue({ count: 0 });
    mocks.sessionFindMany.mockResolvedValue([]);
    mocks.sessionDeleteMany.mockResolvedValue({ count: 0 });
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.healthDeleteMany.mockResolvedValue({ count: 0 });
    mocks.enqueueBulk.mockImplementation(async (list: unknown[]) => list.length);
    mocks.getQueue.mockReturnValue(null);
    mocks.adManagerEnabled.mockReturnValue(false);
    start();
    await flush();
    expect(queues()).toEqual(["integration-health-check"]);
  });

  it("prunes old bookkeeping, OAuth state, cache rows and audit logs with the right cutoffs", async () => {
    const now = new Date();
    // A-DB-10: pruning selects ids first (bounded batches), then
    // deletes exactly those ids — one findMany + one deleteMany per
    // table when a single partial batch drains it.
    mocks.syncJobFindMany.mockResolvedValueOnce([{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }]);
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 3 });
    mocks.oauthStateFindMany.mockResolvedValueOnce([{ id: "state-1" }]);
    mocks.oauthStateDeleteMany.mockResolvedValue({ count: 1 });
    mocks.cacheFindMany.mockResolvedValueOnce([{ id: "cache-1" }, { id: "cache-2" }]);
    mocks.cacheDeleteMany.mockResolvedValue({ count: 2 });
    mocks.auditFindMany.mockResolvedValueOnce([
      { id: "audit-1" },
      { id: "audit-2" },
      { id: "audit-3" },
      { id: "audit-4" },
    ]);
    mocks.auditDeleteMany.mockResolvedValue({ count: 4 });
    start();
    await flush();

    const closeTo = (actual: Date, expectedMs: number) => Math.abs(actual.getTime() - expectedMs) < 5_000;
    const syncWhere = mocks.syncJobFindMany.mock.calls[0][0].where as {
      updatedAt: { lt: Date };
      status: { in: string[] };
    };
    expect(closeTo(syncWhere.updatedAt.lt, now.getTime() - 30 * DAY_MS)).toBe(true);
    // A-DB-10: the 30-day prune also covers orphaned PENDING/RETRYING
    // rows (manual-sync rows whose enqueue failed; retry cycles
    // complete in hours, so a 30-day-old RETRYING row is dead).
    expect(syncWhere.status.in).toEqual(["SUCCEEDED", "FAILED", "PENDING", "RETRYING"]);
    expect(mocks.syncJobFindMany.mock.calls[0][0]).toMatchObject({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    expect(mocks.syncJobDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["job-1", "job-2", "job-3"] } } });
    const stateWhere = mocks.oauthStateFindMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(stateWhere.expiresAt.lt, now.getTime() - DAY_MS)).toBe(true);
    expect(mocks.oauthStateDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["state-1"] } } });
    const cacheWhere = mocks.cacheFindMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(cacheWhere.expiresAt.lt, now.getTime())).toBe(true);
    expect(mocks.cacheDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["cache-1", "cache-2"] } } });
    const auditWhere = mocks.auditFindMany.mock.calls[0][0].where as { createdAt: { lt: Date } };
    expect(closeTo(auditWhere.createdAt.lt, now.getTime() - 365 * DAY_MS)).toBe(true);
    expect(mocks.auditDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["audit-1", "audit-2", "audit-3", "audit-4"] } },
    });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old sync-job rows", { count: 3, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired OAuth states", { count: 1, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired analytics cache rows", { count: 2, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old audit logs", { count: 4, capped: false });
  });

  it("prunes expired invites, verifications, sessions and NULL-website health rows (A-DB-13)", async () => {
    const now = new Date();
    // A-DB-13: the retention tick also drains the four tables the
    // original prune missed — expired unaccepted invites, expired
    // better-auth verifications, expired sessions, and IntegrationHealth
    // rows with no website (unreadable: no consumer can find them by
    // the unique key).
    mocks.inviteFindMany.mockResolvedValueOnce([{ id: "inv-1" }, { id: "inv-2" }]);
    mocks.inviteDeleteMany.mockResolvedValue({ count: 2 });
    mocks.verificationFindMany.mockResolvedValueOnce([{ id: "ver-1" }]);
    mocks.verificationDeleteMany.mockResolvedValue({ count: 1 });
    mocks.sessionFindMany.mockResolvedValueOnce([{ id: "ses-1" }, { id: "ses-2" }]);
    mocks.sessionDeleteMany.mockResolvedValue({ count: 2 });
    mocks.healthFindMany.mockResolvedValueOnce([{ id: "health-1" }]);
    mocks.healthDeleteMany.mockResolvedValue({ count: 1 });
    start();
    await flush();

    const closeTo = (actual: Date, expectedMs: number) => Math.abs(actual.getTime() - expectedMs) < 5_000;
    const inviteWhere = mocks.inviteFindMany.mock.calls[0][0].where as {
      acceptedAt: null;
      expiresAt: { lt: Date };
    };
    expect(inviteWhere.acceptedAt).toBeNull();
    expect(closeTo(inviteWhere.expiresAt.lt, now.getTime())).toBe(true);
    expect(mocks.inviteFindMany.mock.calls[0][0]).toMatchObject({
      select: { id: true },
      orderBy: { id: "asc" },
      take: 1000,
    });
    expect(mocks.inviteDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["inv-1", "inv-2"] } } });
    const verWhere = mocks.verificationFindMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(verWhere.expiresAt.lt, now.getTime())).toBe(true);
    expect(mocks.verificationDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ver-1"] } } });
    const sesWhere = mocks.sessionFindMany.mock.calls[0][0].where as { expiresAt: { lt: Date } };
    expect(closeTo(sesWhere.expiresAt.lt, now.getTime())).toBe(true);
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["ses-1", "ses-2"] } } });
    expect(mocks.healthFindMany.mock.calls[0][0].where).toEqual({ websiteId: null });
    expect(mocks.healthDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["health-1"] } } });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired invites", { count: 2, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired verifications", { count: 1, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned expired sessions", { count: 2, capped: false });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned NULL-website health rows", { count: 1, capped: false });
  });

  it("prunes 5,000 old finished jobs in bounded 1,000-row batches and resolves 100 stuck RUNNING jobs (A-DB-10)", async () => {
    const now = new Date();
    // Five full 1,000-id batches, then an empty select: the drain.
    let batch = 0;
    mocks.syncJobFindMany.mockImplementation(async () => {
      if (batch >= 5) return [];
      const ids = Array.from({ length: 1000 }, (_, i) => ({ id: `job-${batch * 1000 + i}` }));
      batch += 1;
      return ids;
    });
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 1000 });
    mocks.syncJobUpdateMany.mockResolvedValue({ count: 100 });
    start();
    await flush();

    // Stuck RUNNING rows are marked FAILED, not deleted: the website
    // becomes due again and the failure stays visible until the
    // 30-day FAILED prune removes it.
    expect(mocks.syncJobUpdateMany).toHaveBeenCalledTimes(1);
    const staleWhere = mocks.syncJobUpdateMany.mock.calls[0][0].where as {
      status: string;
      updatedAt: { lt: Date };
    };
    expect(staleWhere.status).toBe("RUNNING");
    expect(Math.abs(staleWhere.updatedAt.lt.getTime() - (now.getTime() - 6 * 3_600_000))).toBeLessThan(5_000);
    expect(mocks.syncJobUpdateMany.mock.calls[0][0].data).toEqual({ status: "FAILED", lastError: "stale_running" });
    expect(mocks.logInfo).toHaveBeenCalledWith("marked stale running sync jobs failed", { count: 100 });
    // No single DELETE ever covers more than one batch.
    expect(mocks.syncJobDeleteMany).toHaveBeenCalledTimes(5);
    for (const call of mocks.syncJobDeleteMany.mock.calls) {
      expect((call[0].where as { id: { in: string[] } }).id.in).toHaveLength(1000);
    }
    expect(mocks.syncJobDeleteMany.mock.calls[0][0].where).toEqual({ id: { in: expect.arrayContaining(["job-0"]) } });
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old sync-job rows", { count: 5000, capped: false });
  });

  it("caps pruning at 10 batches per tick when the backlog is larger (A-DB-10)", async () => {
    // The select never drains: every call returns a full batch.
    mocks.syncJobFindMany.mockImplementation(async () => Array.from({ length: 1000 }, (_, i) => ({ id: `job-${i}` })));
    mocks.syncJobDeleteMany.mockResolvedValue({ count: 1000 });
    start();
    await flush();

    expect(mocks.syncJobFindMany).toHaveBeenCalledTimes(10);
    expect(mocks.syncJobDeleteMany).toHaveBeenCalledTimes(10);
    expect(mocks.logInfo).toHaveBeenCalledWith("pruned old sync-job rows", { count: 10000, capped: true });
  });

  it("does not mark RUNNING jobs stale before the 6-hour threshold (A-DB-10)", async () => {
    // updateMany resolves 0: no RUNNING row is older than 6h.
    mocks.syncJobUpdateMany.mockResolvedValue({ count: 0 });
    start();
    await flush();

    expect(mocks.syncJobUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.logInfo).not.toHaveBeenCalledWith("marked stale running sync jobs failed", expect.anything());
  });

  it("sweeps member-less shell orgs with the full empty guard, bounded per tick (A-DB-05)", async () => {
    const now = new Date();
    mocks.orgFindMany.mockResolvedValue([{ id: "org-old" }, { id: "org-old-2" }]);
    mocks.orgDeleteMany.mockResolvedValue({ count: 2 });
    start();
    await flush();

    const sweepGuard = {
      users: { none: {} },
      teams: { none: {} },
      websites: { none: {} },
      connections: { none: {} },
      auditLogs: { none: {} },
      invites: { none: { acceptedAt: null, expiresAt: { gt: expect.any(Date) } } },
    };
    expect(mocks.orgFindMany).toHaveBeenCalledWith({
      where: sweepGuard,
      select: { id: true },
      take: 100,
    });
    const deleteWhere = mocks.orgDeleteMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(deleteWhere.id).toEqual({ in: ["org-old", "org-old-2"] });
    expect(deleteWhere.users).toEqual({ none: {} });
    expect(deleteWhere.auditLogs).toEqual({ none: {} });
    expect(deleteWhere.invites).toEqual({ none: { acceptedAt: null, expiresAt: { gt: expect.any(Date) } } });
    const inviteExpiry = (deleteWhere.invites as { none: { expiresAt: { gt: Date } } }).none.expiresAt.gt;
    expect(Math.abs(inviteExpiry.getTime() - now.getTime())).toBeLessThan(5_000);
    expect(mocks.logInfo).toHaveBeenCalledWith("swept member-less shell orgs", { count: 2 });
  });

  it("sweep skips the delete when no member-less orgs are found", async () => {
    mocks.orgFindMany.mockResolvedValue([]);
    start();
    await flush();

    expect(mocks.orgDeleteMany).not.toHaveBeenCalled();
  });

  it("with no work at all, enqueues nothing and logs no tick summary", async () => {
    start();
    await flush();

    expect(mocks.enqueueBulk).toHaveBeenCalledWith([]);
    expect(mocks.logInfo).not.toHaveBeenCalledWith("tick enqueued jobs", expect.anything());
    // Retention still runs even on an empty tick: the batched prune
    // selects (and finds nothing), so no delete runs at all.
    expect(mocks.syncJobFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.syncJobDeleteMany).not.toHaveBeenCalled();
    expect(mocks.syncJobUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("A-WRK-04: heartbeat renews the lock across a slow tick so a second instance cannot acquire it", async () => {
    // A fake Redis that models TTL expiry: the lock expires 55 s after
    // the last SET/PEXPIRE unless renewed.
    let lock: { token: string; expiresAt: number } | null = null;
    mocks.redisSet.mockImplementation(async (_key: string, token: string, _px: string, ttl: number, _nx: string) => {
      if (lock && Date.now() < lock.expiresAt) return null;
      lock = { token, expiresAt: Date.now() + ttl };
      return "OK";
    });
    mocks.redisEval.mockImplementation(
      async (script: string, _n: number, _key: string, token: string, ttl?: number) => {
        if (script.includes("PEXPIRE")) {
          if (lock && lock.token === token) {
            lock.expiresAt = Date.now() + (ttl ?? 0);
            return 1;
          }
          return 0;
        }
        if (lock && lock.token === token) {
          lock = null;
          return 1;
        }
        return 0;
      },
    );
    // Artificially slow website scan: resolves after 70 s of fake time
    // (past the 55 s TTL, so without renewal the lock would be gone).
    mocks.websiteFindMany.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 70_000)));
    start();
    await vi.advanceTimersByTimeAsync(60_000);
    // At 60 s the lock would have expired without the 20 s heartbeat
    // (renewals at 20/40/60 s extended it to 115 s): a second
    // instance's SET NX must fail.
    expect(await mocks.redisSet(LOCK_KEY, "other-token", "PX", 55_000, "NX")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    // Only the first tick enqueued (the slow scan finished at 70 s).
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
  });

  it("A-WRK-04: a tick whose lock is lost aborts before enqueueing and the next tick can still run", async () => {
    // Renewal reports the lock gone (another instance took it).
    mocks.redisEval.mockImplementation(async (script: string) => (script.includes("PEXPIRE") ? 0 : 1));
    mocks.websiteFindMany.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 70_000)));
    start();
    await vi.advanceTimersByTimeAsync(70_000);

    // The 20 s renewal saw the lock gone and aborted the tick at the
    // next phase boundary (after the slow scan): nothing enqueued.
    expect(mocks.enqueueBulk).not.toHaveBeenCalled();
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.lock_lost");
    expect(mocks.logWarn).toHaveBeenCalledWith("scheduler lock lost during tick; aborting tick", {});
    expect(mocks.incr).not.toHaveBeenCalledWith("scheduler.tick_failed");

    // tickRunning was reset: restore fast defaults and the next
    // interval tick runs normally.
    mocks.redisEval.mockImplementation(async () => 1);
    mocks.websiteFindMany.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
  });

  it("A-WRK-04: a tick that runs past the watchdog timeout aborts before enqueueing", async () => {
    mocks.websiteFindMany.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 130_000)));
    start();
    await vi.advanceTimersByTimeAsync(130_000);

    // The 120 s watchdog aborted the tick at the next phase boundary
    // (after the slow scan): nothing enqueued.
    expect(mocks.enqueueBulk).not.toHaveBeenCalled();
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.tick_timeout");
    expect(mocks.logWarn).toHaveBeenCalledWith("scheduler tick timed out; aborting tick", { timeoutMs: 120_000 });
    expect(mocks.incr).not.toHaveBeenCalledWith("scheduler.tick_failed");
  });

  it("A-WRK-04: a failed lock renewal (Redis error) does not abort the tick", async () => {
    mocks.redisEval.mockImplementation(async (script: string) => {
      if (script.includes("PEXPIRE")) throw new Error("redis down");
      return 1;
    });
    mocks.websiteFindMany.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 70_000)));
    start();
    await vi.advanceTimersByTimeAsync(70_000);

    // Renewals failed (Redis unreachable, so no other instance could
    // have taken the lock either); the tick completed normally.
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.lock_renew_failed");
    expect(mocks.incr).not.toHaveBeenCalledWith("scheduler.lock_lost");
  });

  it("A-WRK-04: a completed tick records its duration", async () => {
    start();
    await flush();

    expect(mocks.incr).toHaveBeenCalledWith("scheduler.tick_duration_ms", expect.any(Number));
    expect(mocks.logInfo).toHaveBeenCalledWith(
      "tick completed",
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it("A-WRK-04: a tick whose scan throws is reported as a failed tick", async () => {
    mocks.websiteFindMany.mockRejectedValue(new Error("db down"));
    start();
    await flush();

    expect(mocks.enqueueBulk).not.toHaveBeenCalled();
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.tick_failed");
    expect(mocks.logError).toHaveBeenCalledWith("tick failed", expect.anything());
  });
});
