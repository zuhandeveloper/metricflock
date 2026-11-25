import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer as createNetServer, type Server as NetServer } from "node:net";

// A-WRK-19: startup with the health port already occupied must be a
// clean, logged exit 1 — not an unhandled `error` event crashing the
// process after all workers have started. Same harness shape as
// worker-shutdown.test.ts (the entry point boots workers, the
// scheduler and an HTTP server at import time, so it is imported
// dynamically with every side effect mocked), except a real listener
// takes the health port BEFORE the import, so the health server's
// listen fails with EADDRINUSE.
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

const HEALTH_PORT = 18097;

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

describe("worker health server listen failure (A-WRK-19)", () => {
  let processExit: ReturnType<typeof vi.spyOn>;
  let occupier: NetServer;
  // Import-time calls (the listen error is emitted asynchronously, so
  // beforeAll polls for it and snapshots the calls for the assertions).
  let callsAtImport = { logError: [] as unknown[][], processExit: [] as unknown[][] };

  beforeAll(async () => {
    // Take the health port first so the worker's listen fails.
    occupier = createNetServer();
    await new Promise<void>((resolve) => occupier.listen(HEALTH_PORT, resolve));

    process.env.WORKER_HEALTH_PORT = String(HEALTH_PORT);
    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    setDefaults();
    await import("@metricflock/worker/index");
    // Wait for the listen error to surface: post-fix the health
    // server's error handler logs the health-specific line and exits
    // 1; pre-fix the unhandled `error` event throws into the module's
    // uncaughtException handler, which also exits 1 (but with the
    // generic line). Either way an exit is recorded, so poll on that.
    const start = Date.now();
    while (processExit.mock.calls.length === 0 && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    callsAtImport = {
      logError: [...mocks.logError.mock.calls],
      processExit: [...processExit.mock.calls],
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => occupier.close(() => resolve()));
    processExit.mockRestore();
  });

  it("logs a clear health-server error and exits 1 when the port is taken", () => {
    expect(callsAtImport.logError).toContainEqual([
      "health server failed — exiting",
      expect.objectContaining({ port: HEALTH_PORT, error: expect.stringContaining("EADDRINUSE") }),
    ]);
    expect(callsAtImport.processExit).toContainEqual([1]);
  });
});
