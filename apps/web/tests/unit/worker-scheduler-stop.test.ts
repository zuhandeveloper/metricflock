import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Scheduler stop() (A-WRK-11): stop() must await an in-flight tick so
// a tick already running cannot keep enqueueing while the workers
// close. Driven through startScheduler with a fake Redis client and
// mocked Prisma / BullMQ queue access, mirroring worker-scheduler.test.ts.
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

describe("scheduler stop() awaits an in-flight tick (A-WRK-11)", () => {
  const started: { stop: () => Promise<void> }[] = [];
  const fakeRedis = { set: mocks.redisSet, eval: mocks.redisEval } as never;

  beforeEach(() => {
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

  afterEach(async () => {
    for (const s of started) await s.stop();
  });

  it("stop() does not resolve until the in-flight tick finishes", async () => {
    // The tick blocks on acquiring the Redis lock.
    let releaseLock!: (value: string) => void;
    mocks.redisSet.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseLock = resolve;
        }),
    );
    const s = startScheduler(fakeRedis);
    started.push(s);

    let stopped = false;
    const stopping = s.stop().then(() => {
      stopped = true;
    });
    // The interval is cleared, but the tick is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);

    releaseLock("OK");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("stop() resolves immediately when no tick is running", async () => {
    const s = startScheduler(fakeRedis);
    started.push(s);
    // The first tick runs on start; wait for it to finish (empty scan).
    await new Promise((resolve) => setTimeout(resolve, 50));
    let stopped = false;
    await s.stop().then(() => {
      stopped = true;
    });
    expect(stopped).toBe(true);
  });
});
