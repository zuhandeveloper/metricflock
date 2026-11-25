import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-DB-16: the scheduler tick paginated websites 500-at-a-time but
// accumulated every page into one in-memory array before planning, so
// tick memory grew linearly with website count despite the pagination.
// It now plans per page (the last-success lookup was already scoped
// per page, A-WRK-05). These tests drive the tick through
// startScheduler with a fake Redis client and mocked Prisma / BullMQ
// queue access, like worker-scheduler.test.ts — except the
// @metricflock/jobs mock wraps the real planDueSyncs and records how
// many websites each call sees, so the test can assert planning never
// holds more than one page.
// (The scheduler is imported via the "@metricflock/worker/scheduler"
// package export.)
const mocks = vi.hoisted(() => ({
  planCalls: [] as number[],
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
  return {
    ...real,
    enqueueBulk: mocks.enqueueBulk,
    getQueue: mocks.getQueue,
    planDueSyncs: (input: Parameters<typeof real.planDueSyncs>[0]) => {
      mocks.planCalls.push(input.websites.length);
      return real.planDueSyncs(input);
    },
  };
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

function ga4Site(id: string) {
  return { id, integrations: [{ provider: "GA4" }] };
}

describe("worker scheduler streaming (A-DB-16)", () => {
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    started.length = 0;
    mocks.planCalls.length = 0;
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

  it("plans per page: planDueSyncs never sees more than one 500-site page", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ga4Site(`site-${i}`));
    const page2 = Array.from({ length: 500 }, (_, i) => ga4Site(`site-${500 + i}`));
    const page3 = Array.from({ length: 200 }, (_, i) => ga4Site(`site-${1000 + i}`));
    mocks.websiteFindMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2).mockResolvedValueOnce(page3);
    start();
    await flush();

    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(3);
    // Per-page planning: three calls, one per page — never one call
    // holding all 1,200 websites. The old code called planDueSyncs
    // once with 1,200.
    expect(mocks.planCalls).toEqual([500, 500, 200]);
    // The due set is unchanged: every site is due (no last successes),
    // so the same 1,200 × 3 entries are enqueued in one bulk call.
    expect(mocks.enqueueBulk).toHaveBeenCalledTimes(1);
    expect(entries()).toHaveLength(1200 * 3);
  });

  it("per-page planning respects each page's own last successes", async () => {
    const now = new Date();
    const page1 = Array.from({ length: 500 }, (_, i) => ga4Site(`site-${i}`));
    // 499 rows so the scan ends here (a full 500-row page would fetch
    // one more empty page, as the existing pagination test shows).
    const page2 = Array.from({ length: 499 }, (_, i) => ga4Site(`site-${500 + i}`));
    mocks.websiteFindMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    // Page 1 was just synced on every queue (recent successes) — not
    // due. Page 2 has no last successes — due. The per-page map must
    // carry page 1's rows for page 1's planning only.
    mocks.groupBy.mockResolvedValueOnce(
      page1.flatMap((w) => [
        { websiteId: w.id, type: "GA4_REALTIME", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
        { websiteId: w.id, type: "GA4_HISTORICAL", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
        { websiteId: w.id, type: "HEALTH_CHECK", _max: { updatedAt: new Date(now.getTime() - 10_000) } },
      ]),
    );
    mocks.groupBy.mockResolvedValueOnce([]);
    start();
    await flush();

    expect(mocks.planCalls).toEqual([500, 499]);
    // Only page 2's 499 sites × 3 queues are enqueued (ids site-500..site-998).
    expect(entries()).toHaveLength(499 * 3);
    expect(
      entries().every((e) => Number(((e.data as { websiteId: string }).websiteId ?? "").replace("site-", "")) >= 500),
    ).toBe(true);
  });
});
