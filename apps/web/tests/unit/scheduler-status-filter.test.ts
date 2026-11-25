import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Worker scheduler status filter (A-WRK-09): the website scan used to
// filter only on a MAPPED integration, so ARCHIVED / SOLD /
// TRANSFER_PENDING / DISCONNECTED sites kept being synced every
// interval. The scan now filters status to ACTIVE + PENDING_SETUP.
// These tests drive the tick through startScheduler with a fake Redis
// client and mocked Prisma / BullMQ queue access — the same harness as
// worker-scheduler.test.ts, except website.findMany is a FAITHFUL mock:
// it applies the where clause the scheduler actually passes (status
// `in` + integrations MAPPED) to the fixture list, the way Postgres
// would. That is what makes the "no jobs planned" assertions real: if
// the status filter is removed from the scan, the archived/sold sites
// come back from the mock and jobs get planned for them.
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

type FixtureSite = {
  id: string;
  status: string;
  integrations: { provider: string; mappingStatus: string }[];
};

// The full fixture set: one MAPPED GA4 site per WebsiteStatus.
const ALL_STATUSES: FixtureSite[] = [
  { id: "site-active", status: "ACTIVE", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
  { id: "site-pending", status: "PENDING_SETUP", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
  { id: "site-disconnected", status: "DISCONNECTED", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
  { id: "site-transfer", status: "TRANSFER_PENDING", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
  { id: "site-sold", status: "SOLD", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
  { id: "site-archived", status: "ARCHIVED", integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }] },
];

// Faithful stand-in for Prisma's website.findMany for the fields the
// scheduler's scan uses: status `in`, integrations.some.mappingStatus,
// plus cursor/take pagination. Returns rows in the scan's select shape
// ({ id, integrations: [{ provider }] }).
function faithfulWebsiteFindMany(args: {
  where?: { status?: { in?: string[] }; integrations?: { some?: { mappingStatus?: string } } };
  cursor?: { id: string };
  skip?: number;
  take?: number;
}) {
  let rows = ALL_STATUSES;
  const where = args.where ?? {};
  if (where.status?.in) rows = rows.filter((w) => where.status!.in!.includes(w.status));
  const mappingStatus = where.integrations?.some?.mappingStatus;
  if (mappingStatus) {
    rows = rows.filter((w) => w.integrations.some((i) => i.mappingStatus === mappingStatus));
  }
  if (args.cursor) {
    const idx = rows.findIndex((w) => w.id === args.cursor!.id);
    rows = rows.slice(idx + (args.skip ?? 0));
  }
  if (typeof args.take === "number") rows = rows.slice(0, args.take);
  return rows.map((w) => ({ id: w.id, integrations: w.integrations.map((i) => ({ provider: i.provider })) }));
}

describe("worker scheduler website status filter (A-WRK-09)", () => {
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
  const websiteIds = () => [...new Set(entries().map((e) => (e.data as { websiteId?: string }).websiteId))].sort();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    started.length = 0;
    mocks.redisSet.mockImplementation(async () => "OK");
    mocks.redisEval.mockImplementation(async () => 1);
    mocks.websiteFindMany.mockImplementation(async (args: Parameters<typeof faithfulWebsiteFindMany>[0]) =>
      faithfulWebsiteFindMany(args),
    );
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

  it("scan query filters status to ACTIVE + PENDING_SETUP alongside the MAPPED integration", async () => {
    start();
    await flush();

    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.websiteFindMany.mock.calls[0]![0].where).toEqual({
      status: { in: ["ACTIVE", "PENDING_SETUP"] },
      integrations: { some: { mappingStatus: "MAPPED" } },
    });
  });

  it("ACTIVE site gets sync jobs (historical + realtime + health check)", async () => {
    start();
    await flush();

    expect(websiteIds()).toContain("site-active");
    const names = entries()
      .filter((e) => (e.data as { websiteId?: string }).websiteId === "site-active")
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["ga4-historical-sync", "ga4-realtime-sync", "integration-health-check"]);
  });

  it("PENDING_SETUP site gets sync jobs", async () => {
    start();
    await flush();

    expect(websiteIds()).toContain("site-pending");
  });

  it("ARCHIVED site gets no jobs", async () => {
    start();
    await flush();

    expect(websiteIds()).not.toContain("site-archived");
  });

  it("SOLD site gets no jobs", async () => {
    start();
    await flush();

    expect(websiteIds()).not.toContain("site-sold");
  });

  it("TRANSFER_PENDING site gets no jobs", async () => {
    start();
    await flush();

    expect(websiteIds()).not.toContain("site-transfer");
  });

  it("DISCONNECTED site gets no jobs — not even a health check (its connection is gone, so every check would only re-record not_connected)", async () => {
    start();
    await flush();

    expect(websiteIds()).not.toContain("site-disconnected");
    expect(entries().some((e) => e.name === "integration-health-check")).toBe(true); // other sites still checked
  });

  it("mixed page: only ACTIVE + PENDING_SETUP sites are planned, and the last-success lookup only sees their ids", async () => {
    start();
    await flush();

    expect(websiteIds()).toEqual(["site-active", "site-pending"]);
    expect(mocks.groupBy).toHaveBeenCalledTimes(1);
    expect(mocks.groupBy.mock.calls[0]![0].where.websiteId).toEqual({ in: ["site-active", "site-pending"] });
  });
});
