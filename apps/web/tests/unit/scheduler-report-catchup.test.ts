import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-WRK-06: weekly report catch-up. A schedule whose last send is >= 7
// days old is due on the next tick whatever the hour, and the missed
// window is counted as scheduler.report_missed. Drives the tick through
// startScheduler with a fake Redis client and mocked Prisma / BullMQ
// queue access (same harness as worker-scheduler.test.ts).
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

const LOCK_KEY = "metricflock:scheduler:lock";
const DAY_MS = 86_400_000;
// Wednesday 2026-11-25 10:30 UTC — outside the Monday 08:00 window.
const NOW = new Date(Date.UTC(2026, 10, 25, 10, 30));

describe("worker scheduler weekly-report catch-up (A-WRK-06)", () => {
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
  const entries = (call = 0) => (mocks.enqueueBulk.mock.calls[call]?.[0] ?? []) as Record<string, unknown>[];
  const reportEntries = (call = 0) => entries(call).filter((e) => e.name === "scheduled-report");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
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

  it("enqueues a missed weekly report as a catch-up on the next tick and counts scheduler.report_missed", async () => {
    const dayBucket = Math.floor(NOW.getTime() / DAY_MS);
    mocks.scheduleFindMany.mockResolvedValue([
      // Stale 9 days, Monday 08:00 window long past — catch-up.
      {
        enabled: true,
        dayOfWeek: 1,
        hourUtc: 8,
        lastSentAt: new Date(Date.UTC(2026, 10, 16, 8, 5)),
        organizationId: "org-catchup",
      },
      // Sent 2 days ago — not due.
      {
        enabled: true,
        dayOfWeek: 1,
        hourUtc: 8,
        lastSentAt: new Date(Date.UTC(2026, 10, 23, 8, 5)),
        organizationId: "org-recent",
      },
      // In its window right now (Wednesday 10:00) — window send, no missed counter.
      { enabled: true, dayOfWeek: 3, hourUtc: 10, lastSentAt: null, organizationId: "org-window" },
    ]);
    start();
    await flush();

    expect(reportEntries()).toContainEqual({
      name: "scheduled-report",
      data: { organizationId: "org-catchup" },
      jobId: `scheduled-report:org-catchup:${dayBucket}`,
    });
    expect(reportEntries()).toContainEqual({
      name: "scheduled-report",
      data: { organizationId: "org-window" },
      jobId: `scheduled-report:org-window:${dayBucket}`,
    });
    expect(reportEntries()).toHaveLength(2);
    expect(mocks.incr).toHaveBeenCalledWith("scheduler.report_missed");
    // Exactly one missed counter for the one catch-up schedule (the
    // tick also records scheduler.tick_duration_ms via the same mock).
    expect(mocks.incr.mock.calls.filter((c) => c[0] === "scheduler.report_missed")).toHaveLength(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "weekly report window missed — sending catch-up",
      expect.objectContaining({ organizationId: "org-catchup" }),
    );
  });

  it("a never-sent schedule outside its window is not a catch-up", async () => {
    mocks.scheduleFindMany.mockResolvedValue([
      { enabled: true, dayOfWeek: 1, hourUtc: 8, lastSentAt: null, organizationId: "org-new" },
    ]);
    start();
    await flush();

    expect(reportEntries()).toHaveLength(0);
    expect(mocks.incr).not.toHaveBeenCalledWith("scheduler.report_missed");
  });

  it("repeat ticks while the catch-up is pending reuse the same dayBucket jobId (one job per day)", async () => {
    const dayBucket = Math.floor(NOW.getTime() / DAY_MS);
    mocks.scheduleFindMany.mockResolvedValue([
      {
        enabled: true,
        dayOfWeek: 1,
        hourUtc: 8,
        lastSentAt: new Date(Date.UTC(2026, 10, 16, 8, 5)),
        organizationId: "org-catchup",
      },
    ]);
    start();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(2);
    expect(reportEntries(0)).toHaveLength(1);
    expect(reportEntries(1)).toHaveLength(1);
    expect(reportEntries(0)[0].jobId).toBe(`scheduled-report:org-catchup:${dayBucket}`);
    expect(reportEntries(1)[0].jobId).toBe(`scheduled-report:org-catchup:${dayBucket}`);
  });
});
