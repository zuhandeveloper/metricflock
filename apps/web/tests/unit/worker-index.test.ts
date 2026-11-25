import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

// apps/worker/src/index.ts: queue wiring, job routing, DLQ-adjacent
// bookkeeping, health endpoints and graceful shutdown. The module has
// no exports and boots workers, the scheduler and an HTTP server at
// import time, so it is imported dynamically (once) with every
// side effect mocked: BullMQ Worker, Redis, Prisma, Google sync,
// mailer, scheduler and report sender. The health server binds a
// real (test-only) port so its endpoints can be exercised over HTTP.
// (The entry point is imported via the "@metricflock/worker/index"
// package export.)
const mocks = vi.hoisted(() => ({
  workers: [] as Record<string, unknown>[],
  workerClose: vi.fn(async () => undefined),
  schedulerStop: vi.fn(),
  startScheduler: vi.fn(),
  sendOrgReport: vi.fn(),
  getRedis: vi.fn(),
  bullConnectionOptions: vi.fn(),
  incr: vi.fn(),
  counterSnapshot: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  fakeRedis: {
    ping: vi.fn(async () => "PONG"),
    disconnect: vi.fn(),
  },
  websiteFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  healthFindUnique: vi.fn(),
  syncJobUpdate: vi.fn(),
  syncJobUpsert: vi.fn(),
  queryRaw: vi.fn(),
  disconnect: vi.fn(),
  recordHealth: vi.fn(),
  syncWebsite: vi.fn(),
  refreshConnection: vi.fn(),
  discoverConnectionProperties: vi.fn(),
  resolveConnection: vi.fn(),
  sendMail: vi.fn(),
}));

// BullMQ is a dependency of @metricflock/worker, not of the web app:
// without the "bullmq" resolve.alias in vitest.config.ts,
// vi.mock("bullmq") resolves a different pnpm copy than the worker
// imports and silently misses (real Workers then try to connect to
// Redis). The alias maps it to the worker's own node_modules copy, so
// the mock hits the same resolved module the worker entry point imports.
vi.mock("bullmq", () => {
  class MockWorker {
    static RateLimitError(): Error {
      const error = new Error("RATE_LIMITED");
      error.name = "RateLimitError";
      return error;
    }
    name: string;
    processor: (job: Record<string, unknown>) => Promise<unknown>;
    opts: unknown;
    handlers = new Map<string, (...args: unknown[]) => void>();
    close = mocks.workerClose;
    constructor(name: string, processor: (job: Record<string, unknown>) => Promise<unknown>, opts: unknown) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      mocks.workers.push(this as unknown as Record<string, unknown>);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.handlers.set(event, fn);
      return this;
    }
  }
  class MockQueue {
    constructor(..._args: unknown[]) {}
  }
  return { Worker: MockWorker, Queue: MockQueue };
});

vi.mock("@metricflock/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@metricflock/shared")>();
  const logger: Record<string, unknown> = {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug,
  };
  logger.child = () => logger;
  return {
    ...real,
    getRedis: mocks.getRedis,
    bullConnectionOptions: mocks.bullConnectionOptions,
    createLogger: () => logger,
    incr: mocks.incr,
    counterSnapshot: mocks.counterSnapshot,
  };
});

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findUnique: mocks.websiteFindUnique },
    user: { findMany: mocks.userFindMany },
    integrationHealth: { findUnique: mocks.healthFindUnique },
    analyticsSyncJob: { update: mocks.syncJobUpdate, upsert: mocks.syncJobUpsert },
    $queryRaw: mocks.queryRaw,
    $disconnect: mocks.disconnect,
  },
}));

vi.mock("@metricflock/db/health", () => ({ recordHealth: mocks.recordHealth }));

vi.mock("@metricflock/google/sync", () => {
  class SyncRateLimitError extends Error {
    constructor(connectionId: string) {
      super(`SYNC_RATE_LIMITED:${connectionId}`);
      this.name = "SyncRateLimitError";
    }
  }
  return {
    syncWebsite: mocks.syncWebsite,
    refreshConnection: mocks.refreshConnection,
    discoverConnectionProperties: mocks.discoverConnectionProperties,
    defaultSyncDeps: {},
    SyncRateLimitError,
  };
});

vi.mock("@metricflock/google/client", () => ({ resolveConnectionForWebsite: mocks.resolveConnection }));
vi.mock("@metricflock/auth/mailer", () => ({ sendMail: mocks.sendMail }));
vi.mock("@metricflock/worker/scheduler", () => ({ startScheduler: mocks.startScheduler }));
vi.mock("@metricflock/worker/report", () => ({ sendOrgReport: mocks.sendOrgReport }));

import { QUEUE_NAMES, SYNC_TYPE_BY_QUEUE } from "@metricflock/jobs";
import { SyncRateLimitError } from "@metricflock/google/sync";

const HEALTH_PORT = 18099;
const HEALTH_BASE = `http://127.0.0.1:${HEALTH_PORT}`;

type CapturedWorker = {
  name: string;
  processor: (job: Record<string, unknown>) => Promise<unknown>;
  opts: Record<string, any>;
  handlers: Map<string, (...args: any[]) => void>;
};

function setDefaults() {
  mocks.getRedis.mockImplementation(() => mocks.fakeRedis);
  mocks.bullConnectionOptions.mockImplementation(() => ({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null }));
  mocks.startScheduler.mockReturnValue({ stop: mocks.schedulerStop });
  mocks.sendOrgReport.mockResolvedValue({ status: "ok", reports: [], detail: "report sent" });
  mocks.syncWebsite.mockResolvedValue({ status: "ok", reports: ["overview"] });
  mocks.refreshConnection.mockResolvedValue({ status: "ok", reports: [] });
  mocks.discoverConnectionProperties.mockResolvedValue({ ga4: 2, searchConsole: 1, adsense: 0, adManager: 0 });
  mocks.resolveConnection.mockResolvedValue({
    status: "connected",
    connectionId: "conn-1",
    level: "WEBSITE",
    googleAccountEmail: "a@example.com",
  });
  mocks.websiteFindUnique.mockResolvedValue({ name: "Site", domain: "example.com", organizationId: "org-1" });
  mocks.userFindMany.mockResolvedValue([{ email: "admin@example.com" }]);
  mocks.healthFindUnique.mockResolvedValue(null);
  mocks.syncJobUpsert.mockResolvedValue({ id: "row-1" });
  mocks.syncJobUpdate.mockResolvedValue({ id: "row-1" });
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.recordHealth.mockResolvedValue({ id: "h1" });
  mocks.counterSnapshot.mockReturnValue({ "jobs.succeeded.ga4-realtime-sync": 3 });
  mocks.sendMail.mockResolvedValue(undefined);
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("worker index (queue wiring and job routing)", () => {
  let processExit: ReturnType<typeof vi.spyOn>;
  // Import-time calls (beforeEach clears mock histories, so snapshot them).
  let callsAtImport = { startScheduler: [] as unknown[][], logInfo: [] as unknown[][], processExit: [] as unknown[][] };

  const workerFor = (name: string): CapturedWorker => {
    const found = mocks.workers.find((w) => w.name === name) as unknown as CapturedWorker | undefined;
    if (!found) throw new Error(`no worker for queue ${name}`);
    return found;
  };
  const runJob = (queue: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    workerFor(queue).processor({ id: "job-42", data, attemptsMade: 0, opts: { attempts: 5 }, ...overrides });
  const lastRowUpdate = () => mocks.syncJobUpdate.mock.calls.at(-1)![0] as { data: Record<string, unknown> };
  const getHealth = async (path: string) => {
    const res = await fetch(`${HEALTH_BASE}${path}`);
    return { status: res.status, body: await res.text() };
  };
  const getWorkerDeps = async () => {
    await runJob("ga4-realtime-sync", { websiteId: "site-1" });
    const calls = mocks.syncWebsite.mock.calls;
    return calls[calls.length - 1][2] as {
      recordHealth: (opts: Record<string, unknown>) => Promise<unknown>;
    };
  };

  beforeAll(async () => {
    process.env.WORKER_HEALTH_PORT = String(HEALTH_PORT);
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    setDefaults();
    await import("@metricflock/worker/index");
    callsAtImport = {
      startScheduler: [...mocks.startScheduler.mock.calls],
      logInfo: [...mocks.logInfo.mock.calls],
      processExit: [...processExit.mock.calls],
    };
    // Wait for the health server to actually listen.
    const start = Date.now();
    for (;;) {
      try {
        const res = await fetch(`${HEALTH_BASE}/healthz`);
        if (res.status === 200) break;
      } catch {
        if (Date.now() - start > 5000) throw new Error("health server did not start");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
  });

  afterAll(async () => {
    // Leave nothing listening: a second SIGTERM is a no-op if the
    // shutdown test already ran (shuttingDown guard).
    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    processExit.mockRestore();
  });

  it("starts one worker per queue with limiter, concurrency and jittered backoff", () => {
    expect(mocks.workers).toHaveLength(QUEUE_NAMES.length);
    expect(mocks.workers.map((w) => w.name).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(callsAtImport.processExit).toHaveLength(0);
    expect(callsAtImport.startScheduler).toEqual([[mocks.fakeRedis]]);
    for (const name of QUEUE_NAMES) {
      const worker = workerFor(name);
      expect(worker.opts.connection).toEqual({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null });
      expect(worker.opts.concurrency).toBe(5);
      expect(typeof worker.opts.settings.backoffStrategy).toBe("function");
    }
    expect(workerFor("ga4-realtime-sync").opts.limiter).toEqual({ max: 20, duration: 60_000 });
    expect(workerFor("search-console-sync").opts.limiter).toEqual({ max: 10, duration: 60_000 });
    expect(workerFor("scheduled-report").opts.limiter).toBeUndefined();
    // Backoff is exponential with jitter. BullMQ invokes the strategy
    // with attemptsMade + 1 (job.js), i.e. 1 on the first failure —
    // assert the EFFECTIVE schedule for those 1-based calls (A-WRK-13):
    // first retry [30s, 60s], doubling per retry; with attempts: 5 the
    // last retry (4th) lands in [240s, 480s].
    const strategy = workerFor("ga4-realtime-sync").opts.settings.backoffStrategy;
    const backoff1 = strategy(1) as number;
    expect(backoff1).toBeGreaterThanOrEqual(30_000);
    expect(backoff1).toBeLessThanOrEqual(60_000);
    const backoff2 = strategy(2) as number;
    expect(backoff2).toBeGreaterThanOrEqual(60_000);
    expect(backoff2).toBeLessThanOrEqual(120_000);
    const backoff4 = strategy(4) as number;
    expect(backoff4).toBeGreaterThanOrEqual(240_000);
    expect(backoff4).toBeLessThanOrEqual(480_000);
    expect(callsAtImport.logInfo).toContainEqual(["worker started", { queue: "ga4-realtime-sync" }]);
  });

  it("serves /healthz, /readyz and /metrics, and 404s unknown paths", async () => {
    const healthz = await getHealth("/healthz");
    expect(healthz.status).toBe(200);
    expect(JSON.parse(healthz.body)).toEqual({ status: "ok" });

    const readyz = await getHealth("/readyz");
    expect(readyz.status).toBe(200);
    expect(JSON.parse(readyz.body)).toEqual({ status: "ready" });
    expect(mocks.fakeRedis.ping).toHaveBeenCalled();
    expect(mocks.queryRaw).toHaveBeenCalled();

    const metrics = await getHealth("/metrics");
    expect(metrics.status).toBe(200);
    const parsed = JSON.parse(metrics.body) as { counters: Record<string, number>; uptimeSeconds: number };
    expect(parsed.counters).toEqual({ "jobs.succeeded.ga4-realtime-sync": 3 });
    expect(typeof parsed.uptimeSeconds).toBe("number");

    expect((await getHealth("/nope")).status).toBe(404);
  });

  it("returns 503 from /readyz when Redis or the DB is unreachable", async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error("db down"));
    expect((await getHealth("/readyz")).status).toBe(503);
    mocks.fakeRedis.ping.mockRejectedValueOnce(new Error("redis down"));
    const res = await getHealth("/readyz");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: "not_ready" });
  });

  it("routes every sync queue to syncWebsite and books the job row as SUCCEEDED", async () => {
    const cases: [string, string][] = [
      ["ga4-realtime-sync", "ga4-realtime"],
      ["ga4-historical-sync", "ga4-historical"],
      ["search-console-sync", "search-console"],
      ["adsense-sync", "adsense"],
      ["ad-manager-sync", "ad-manager"],
      ["analytics-cache-refresh", "cache-refresh"],
      ["integration-health-check", "health-check"],
    ];
    for (const [queue, kind] of cases) {
      vi.clearAllMocks();
      setDefaults();
      const result = (await runJob(queue, { websiteId: "site-1" })) as { status: string };
      expect(result.status).toBe("ok");
      expect(mocks.syncWebsite).toHaveBeenCalledWith(
        "site-1",
        kind,
        expect.objectContaining({ recordHealth: expect.any(Function) }),
      );
      // One bookkeeping row per job, upserted by externalId (OPS-3).
      expect(mocks.syncJobUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { externalId: "job-42" },
          create: expect.objectContaining({
            websiteId: "site-1",
            type: SYNC_TYPE_BY_QUEUE[queue as keyof typeof SYNC_TYPE_BY_QUEUE],
            status: "RUNNING",
            attempts: 1,
          }),
        }),
      );
      expect(lastRowUpdate().data.status).toBe("SUCCEEDED");
      expect(lastRowUpdate().data.lastError).toBeNull();
      expect(lastRowUpdate().data.lastRunAt).toBeInstanceOf(Date);
      // Event-driven queues have no interval, so no next run is scheduled.
      if (kind === "cache-refresh") expect(lastRowUpdate().data.nextRunAt).toBeNull();
      else expect(lastRowUpdate().data.nextRunAt).toBeInstanceOf(Date);
    }
  });

  it("routes scheduled-report jobs to sendOrgReport, and skips jobs without an organization", async () => {
    const result = (await runJob("scheduled-report", { organizationId: "org-1" })) as { status: string };
    expect(result.status).toBe("ok");
    expect(mocks.sendOrgReport).toHaveBeenCalledWith("org-1");
    expect(mocks.syncWebsite).not.toHaveBeenCalled();

    vi.clearAllMocks();
    setDefaults();
    const skipped = (await runJob("scheduled-report", {})) as { status: string; detail: string };
    expect(skipped.status).toBe("skipped");
    expect(skipped.detail).toBe("report job without organizationId");
    expect(mocks.sendOrgReport).not.toHaveBeenCalled();
  });

  it("routes OAuth refresh through the job's connection, or the website's resolved connection", async () => {
    await runJob("google-oauth-refresh", { connectionId: "conn-9" });
    expect(mocks.refreshConnection).toHaveBeenCalledWith("conn-9");
    expect(mocks.resolveConnection).not.toHaveBeenCalled();

    vi.clearAllMocks();
    setDefaults();
    await runJob("google-oauth-refresh", { websiteId: "site-1" });
    expect(mocks.resolveConnection).toHaveBeenCalledWith("site-1");
    expect(mocks.refreshConnection).toHaveBeenCalledWith("conn-1");

    vi.clearAllMocks();
    setDefaults();
    mocks.resolveConnection.mockResolvedValue({ status: "not_connected", connectionId: null });
    const result = (await runJob("google-oauth-refresh", { websiteId: "site-1" })) as {
      status: string;
      detail: string;
    };
    expect(result).toEqual({ status: "not_connected", reports: [], detail: "No connection to refresh." });
    expect(mocks.refreshConnection).not.toHaveBeenCalled();

    vi.clearAllMocks();
    setDefaults();
    const noTarget = (await runJob("google-oauth-refresh", {})) as { status: string };
    expect(noTarget.status).toBe("not_connected");
  });

  it("routes property discovery and reports the discovered counts", async () => {
    const result = (await runJob("google-property-discovery", { connectionId: "conn-9" })) as {
      status: string;
      detail: string;
    };
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("discovered ga4=2 searchConsole=1 adsense=0 adManager=0");
    expect(mocks.discoverConnectionProperties).toHaveBeenCalledWith("conn-9");

    vi.clearAllMocks();
    setDefaults();
    await runJob("google-property-discovery", { websiteId: "site-1" });
    expect(mocks.discoverConnectionProperties).toHaveBeenCalledWith("conn-1");
    vi.clearAllMocks();
    setDefaults();
    mocks.resolveConnection.mockResolvedValue({ status: "not_connected", connectionId: null });
    const unconnected = (await runJob("google-property-discovery", { websiteId: "site-1" })) as {
      status: string;
      detail: string;
    };
    expect(unconnected).toEqual({
      status: "not_connected",
      reports: [],
      detail: "No connection to discover properties for.",
    });
  });

  it("property discovery surfaces per-provider errors and pruned counts in the detail (A-GGL-13)", async () => {
    mocks.discoverConnectionProperties.mockResolvedValue({
      ga4: 0,
      searchConsole: 1,
      adsense: 1,
      adManager: 0,
      errors: { ga4: "Analytics Admin API has not been used" },
      pruned: { searchConsole: 2 },
    });
    const result = (await runJob("google-property-discovery", { connectionId: "conn-9" })) as {
      status: string;
      detail: string;
    };
    expect(result.status).toBe("ok");
    expect(result.detail).toBe(
      "discovered ga4=0 searchConsole=1 adsense=1 adManager=0; errors: ga4=Analytics Admin API has not been used; pruned: searchConsole=2",
    );
  });

  it("updates the pre-created sync-job row when syncJobRowId is passed instead of upserting", async () => {
    await runJob("ga4-realtime-sync", { websiteId: "site-1", syncJobRowId: "row-9" });
    expect(mocks.syncJobUpsert).not.toHaveBeenCalled();
    expect(mocks.syncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-9" },
        data: expect.objectContaining({ status: "RUNNING", externalId: "job-42" }),
      }),
    );
    // The first update call is the RUNNING mark; the second is SUCCEEDED.
    expect(mocks.syncJobUpdate).toHaveBeenCalledTimes(2);
  });

  it("records a non-ok sync result as SUCCEEDED with the status as the last error", async () => {
    mocks.syncWebsite.mockResolvedValue({ status: "skipped", reports: [], detail: "no mapping" });
    const result = (await runJob("search-console-sync", { websiteId: "site-1" })) as { status: string };
    expect(result.status).toBe("skipped");
    expect(lastRowUpdate().data.status).toBe("SUCCEEDED");
    expect(lastRowUpdate().data.lastError).toBe("skipped: no mapping");
  });

  it("records a non-ok sync result without detail as just the status", async () => {
    mocks.syncWebsite.mockResolvedValue({ status: "skipped", reports: [] });
    const result = (await runJob("search-console-sync", { websiteId: "site-1" })) as { status: string };
    expect(result.status).toBe("skipped");
    expect(lastRowUpdate().data.lastError).toBe("skipped");
  });

  it("records a non-Error throw via String(err) and rethrows it as-is", async () => {
    mocks.syncWebsite.mockRejectedValue("plain string failure");
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe("plain string failure");
    expect(lastRowUpdate().data.status).toBe("RETRYING");
    expect(lastRowUpdate().data.lastError).toBe("plain string failure");
  });

  it("defaults a job without an attempts count to a single attempt", async () => {
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 0, opts: {} });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("Google 500");
    // (undefined ?? 1) - 0 - 1 = 0 attempts left: terminal failure, alert sent.
    expect(lastRowUpdate().data.status).toBe("FAILED");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("terminal alert falls back to generic dashboard text without NEXT_PUBLIC_APP_URL", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 4 });
    } catch {
      // expected
    }
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    expect(mail.text).toContain("Open the dashboard to investigate.");
  });

  it("turns a per-connection rate limit into a BullMQ RateLimitError with a RETRYING row", async () => {
    mocks.syncWebsite.mockRejectedValue(new SyncRateLimitError("conn-1"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe("RateLimitError");
    expect(lastRowUpdate().data.status).toBe("RETRYING");
    // A-WRK-14: the note must name the actual state — waiting under the
    // queue limiter, not a backoff retry after a failed attempt.
    expect(lastRowUpdate().data.lastError).toBe(
      "rate limited (per-connection quota); job waiting under queue limiter (no attempt consumed)",
    );
    // A-WRK-14: BullMQ swallows RateLimitError without emitting "failed",
    // so jobs.failed.* never fires — the branch counts + logs it itself.
    expect(mocks.incr).toHaveBeenCalledWith("jobs.ratelimited.ga4-realtime-sync");
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "job rate limited — waiting under queue limiter",
      expect.objectContaining({ queue: "ga4-realtime-sync", jobId: "job-42", websiteId: "site-1" }),
    );
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("retries a transient failure without alerting while attempts remain", async () => {
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 0 });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("Google 500");
    expect(lastRowUpdate().data.status).toBe("RETRYING");
    expect(lastRowUpdate().data.lastError).toBe("Google 500");
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.incr).not.toHaveBeenCalledWith(expect.stringContaining("terminal_failed"));
  });

  it("marks a terminal failure FAILED and emails the org SUPER_ADMINs", async () => {
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 4 });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("Google 500");
    expect(lastRowUpdate().data.status).toBe("FAILED");
    expect(mocks.incr).toHaveBeenCalledWith("jobs.terminal_failed.ga4-realtime-sync");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendMail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe("admin@example.com");
    expect(mail.subject).toBe("MetricFlock: sync failed for example.com");
    expect(mail.text).toContain("The ga4-realtime-sync sync for Site (example.com) failed after all retries.");
    expect(mail.text).toContain("Error: Google 500");
    expect(mail.text).toContain("https://app.example.com/websites/site-1");
  });

  it("sends no terminal alert when the job has no website or the website is gone", async () => {
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", {}, { attemptsMade: 4 });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("Google 500");
    expect(lastRowUpdate().data.status).toBe("FAILED");
    expect(mocks.incr).not.toHaveBeenCalledWith(expect.stringContaining("terminal_failed"));
    expect(mocks.sendMail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    setDefaults();
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    mocks.websiteFindUnique.mockResolvedValue(null);
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 4 });
    } catch {
      // expected
    }
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("a failing alert email never masks the job error", async () => {
    mocks.syncWebsite.mockRejectedValue(new Error("Google 500"));
    mocks.sendMail.mockRejectedValue(new Error("SMTP down"));
    let caught: unknown;
    try {
      await runJob("ga4-realtime-sync", { websiteId: "site-1" }, { attemptsMade: 4 });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("Google 500");
    expect(mocks.logError).toHaveBeenCalledWith("sync failure alert email failed", expect.anything());
  });

  it("alerting recordHealth emails once per health transition, and never on a steady state", async () => {
    const deps = await getWorkerDeps();

    // First-ever error: alerts.
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "error", lastError: "boom" });
    expect(mocks.recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ websiteId: "site-1", provider: "GA4", status: "error" }),
    );
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const alert = mocks.sendMail.mock.calls[0][0] as { subject: string; text: string };
    expect(alert.subject).toBe("MetricFlock: GA4 integration failing for example.com");
    expect(alert.text).toContain("Error: boom");
    expect(alert.text).toContain("https://app.example.com/health");

    // Same error again: silent.
    vi.clearAllMocks();
    setDefaults();
    mocks.healthFindUnique.mockResolvedValue({ status: "error" });
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "error", lastError: "boom" });
    expect(mocks.sendMail).not.toHaveBeenCalled();

    // Recovery: alerts once.
    vi.clearAllMocks();
    setDefaults();
    mocks.healthFindUnique.mockResolvedValue({ status: "error" });
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "ok", success: true });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect((mocks.sendMail.mock.calls[0][0] as { subject: string }).subject).toBe(
      "MetricFlock: GA4 integration recovered for example.com",
    );

    // Steady ok: silent.
    vi.clearAllMocks();
    setDefaults();
    mocks.healthFindUnique.mockResolvedValue({ status: "ok" });
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "ok", success: true });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("alerting recordHealth stays silent when the website vanished mid-transition", async () => {
    const deps = await getWorkerDeps();
    mocks.healthFindUnique.mockResolvedValue({ status: "error" }); // prev error + ok = "recovered" transition
    mocks.websiteFindUnique.mockResolvedValue(null); // website deleted after the transition fired
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "ok", success: true });
    expect(mocks.recordHealth).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("alerting recordHealth tolerates a failed previous-status lookup and a failing alert email", async () => {
    const deps = await getWorkerDeps();
    mocks.healthFindUnique.mockRejectedValue(new Error("db blip"));
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "error", lastError: "boom" });
    // Lookup failure is treated as "no previous record": a first error still alerts.
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    setDefaults();
    mocks.sendMail.mockRejectedValue(new Error("SMTP down"));
    await expect(
      deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "error", lastError: "boom" }),
    ).resolves.toBeDefined();
    expect(mocks.recordHealth).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith("health alert email failed", expect.anything());
  });

  it("alerting recordHealth skips alerts for connection-level rows without a website", async () => {
    const deps = await getWorkerDeps();
    await deps.recordHealth({ provider: "GA4", status: "error", lastError: "boom" });
    expect(mocks.healthFindUnique).not.toHaveBeenCalled();
    expect(mocks.recordHealth).toHaveBeenCalledTimes(1);
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("alert emails fall back to generic dashboard text without NEXT_PUBLIC_APP_URL", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const deps = await getWorkerDeps();
    await deps.recordHealth({ websiteId: "site-1", provider: "GA4", status: "error", lastError: "boom" });
    const alert = mocks.sendMail.mock.calls[0][0] as { text: string };
    expect(alert.text).toContain("Open the Health page in the dashboard to investigate.");
  });

  it("worker completed/failed events update the job counters", () => {
    const worker = workerFor("ga4-realtime-sync");
    worker.handlers.get("completed")!();
    expect(mocks.incr).toHaveBeenCalledWith("jobs.succeeded.ga4-realtime-sync");
    worker.handlers.get("failed")!({ id: "job-1" }, new Error("boom"));
    expect(mocks.incr).toHaveBeenCalledWith("jobs.failed.ga4-realtime-sync");
    expect(mocks.logError).toHaveBeenCalledWith(
      "job failed",
      expect.objectContaining({ queue: "ga4-realtime-sync", jobId: "job-1", error: "boom" }),
    );
  });

  // Must run last: shutdown closes the workers and the health server.
  it("shuts down gracefully on SIGTERM and ignores a second signal", async () => {
    // A failing DB disconnect must not block shutdown (the .catch swallows it).
    mocks.disconnect.mockRejectedValueOnce(new Error("db down"));
    process.emit("SIGTERM");
    await waitFor(() => processExit.mock.calls.length > 0);
    expect(mocks.schedulerStop).toHaveBeenCalledTimes(1);
    expect(mocks.workerClose).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.fakeRedis.disconnect).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
    expect(mocks.logInfo).toHaveBeenCalledWith("shutting down gracefully", { signal: "SIGTERM" });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processExit).toHaveBeenCalledTimes(1);
    expect(mocks.workerClose).toHaveBeenCalledTimes(QUEUE_NAMES.length);
  });
});
