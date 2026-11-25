import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Worker shutdown (A-WRK-11): crash handlers, bounded drain with a
// force-close timeout, and stop() awaiting an in-flight tick. The entry
// point boots workers, the scheduler and an HTTP server at import time,
// so it is imported dynamically (once) with every side effect mocked —
// the same harness shape as worker-index.test.ts. The shutdown test
// must run last: once SIGTERM fires, the module's shuttingDown guard
// makes a second signal a no-op.
const mocks = vi.hoisted(() => ({
  workers: [] as Record<string, unknown>[],
  workerClose: vi.fn(),
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

import { QUEUE_NAMES } from "@metricflock/jobs";

// No static import of "@metricflock/worker/index": importing it boots
// workers, the scheduler and the health server, so it is imported
// dynamically in beforeAll (after the mocks and the process.exit spy
// are installed) and the exported crash handlers / timeout are captured
// there.
let handleUncaughtException!: (err: unknown) => void;
let handleUnhandledRejection!: (reason: unknown) => void;
let SHUTDOWN_TIMEOUT_MS!: number;

const HEALTH_PORT = 18098;
const HEALTH_BASE = `http://127.0.0.1:${HEALTH_PORT}`;

function setDefaults() {
  mocks.getRedis.mockImplementation(() => mocks.fakeRedis);
  mocks.bullConnectionOptions.mockImplementation(() => ({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null }));
  mocks.startScheduler.mockReturnValue({ stop: mocks.schedulerStop });
  mocks.schedulerStop.mockResolvedValue(undefined);
  mocks.workerClose.mockResolvedValue(undefined);
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
  mocks.counterSnapshot.mockReturnValue({});
  mocks.sendMail.mockResolvedValue(undefined);
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("worker shutdown (A-WRK-11)", () => {
  let processExit: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Short drain timeout so the force-close path is fast to observe.
    process.env.WORKER_SHUTDOWN_TIMEOUT_MS = "200";
    process.env.WORKER_HEALTH_PORT = String(HEALTH_PORT);
    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    setDefaults();
    const workerIndex = await import("@metricflock/worker/index");
    handleUncaughtException = workerIndex.handleUncaughtException;
    handleUnhandledRejection = workerIndex.handleUnhandledRejection;
    SHUTDOWN_TIMEOUT_MS = workerIndex.SHUTDOWN_TIMEOUT_MS;
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

  afterAll(() => {
    processExit.mockRestore();
  });

  it("reads the shutdown timeout from the environment", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(200);
  });

  it("an uncaught exception is logged and exits non-zero (not silent)", () => {
    handleUncaughtException(new Error("boom"));
    expect(mocks.logError).toHaveBeenCalledWith("uncaught exception — crashing", expect.anything());
    expect(processExit).toHaveBeenCalledWith(1);
  });

  it("an unhandled rejection is logged and exits non-zero (not silent)", () => {
    handleUnhandledRejection(new Error("stray redis rejection"));
    expect(mocks.logError).toHaveBeenCalledWith("unhandled rejection — crashing", expect.anything());
    expect(processExit).toHaveBeenCalledWith(1);
  });

  // Must run last: shutdown closes the workers and the health server.
  it("shutdown with a slow in-flight job exits within the timeout and force-closes workers", async () => {
    // A tick is still running when SIGTERM lands: stop() must be
    // awaited before any worker closes.
    mocks.schedulerStop.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    // Graceful close waits for the in-flight job forever; only a
    // force-close returns.
    mocks.workerClose.mockImplementation((force?: boolean) =>
      force ? Promise.resolve(undefined) : new Promise<never>(() => {}),
    );

    const startedAt = Date.now();
    process.emit("SIGTERM");

    // While stop() is still pending, no worker may close yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.workerClose).not.toHaveBeenCalled();

    await waitFor(() => processExit.mock.calls.length > 0);
    const elapsedMs = Date.now() - startedAt;
    // 150 ms tick + 200 ms drain timeout; far below what an unbounded
    // close() would take (it never resolves here).
    expect(elapsedMs).toBeLessThan(2000);

    expect(mocks.schedulerStop).toHaveBeenCalledTimes(1);
    expect(mocks.schedulerStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.workerClose.mock.invocationCallOrder[0]);
    // One graceful close per worker, then one force-close per worker.
    expect(mocks.workerClose).toHaveBeenCalledTimes(QUEUE_NAMES.length * 2);
    expect(mocks.workerClose).toHaveBeenCalledWith(true);
    expect(mocks.logWarn).toHaveBeenCalledWith("shutdown timed out — force-closing workers", { timeoutMs: 200 });
    expect(mocks.logInfo).toHaveBeenCalledWith("shutting down gracefully", { signal: "SIGTERM" });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.fakeRedis.disconnect).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);

    // The health server is closed: readiness probes stop being served.
    await expect(fetch(`${HEALTH_BASE}/healthz`)).rejects.toThrow();
  });
});
