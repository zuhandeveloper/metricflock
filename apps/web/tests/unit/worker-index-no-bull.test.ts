import { describe, it, expect, vi } from "vitest";

// apps/worker/src/index.ts, BullMQ-connection-missing path: Redis is
// present but bullConnectionOptions() is null, so the worker still
// exits 1 at import time. The SIGINT shutdown handler is exercised
// here (the main index test file covers SIGTERM; both call the same
// shutdown, and the shuttingDown guard allows only one per import).
const mocks = vi.hoisted(() => ({
  workerClose: vi.fn(async () => undefined),
  schedulerStop: vi.fn(),
  startScheduler: vi.fn(),
  getRedis: vi.fn(),
  bullConnectionOptions: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  fakeRedis: { ping: vi.fn(async () => "PONG"), disconnect: vi.fn() },
  disconnect: vi.fn(),
}));

vi.mock("bullmq", () => {
  class MockWorker {
    close = mocks.workerClose;
    constructor(
      public name: string,
      _processor: unknown,
      _opts: unknown,
    ) {}
    on() {
      return this;
    }
  }
  return { Worker: MockWorker, Queue: class {} };
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
  };
});

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    integrationHealth: { findUnique: vi.fn() },
    analyticsSyncJob: { update: vi.fn(), upsert: vi.fn() },
    $queryRaw: vi.fn(),
    $disconnect: mocks.disconnect,
  },
}));
vi.mock("@metricflock/db/health", () => ({ recordHealth: vi.fn() }));
vi.mock("@metricflock/google/sync", () => ({
  syncWebsite: vi.fn(),
  refreshConnection: vi.fn(),
  discoverConnectionProperties: vi.fn(),
  defaultSyncDeps: {},
  SyncRateLimitError: class extends Error {},
}));
vi.mock("@metricflock/google/client", () => ({ resolveConnectionForWebsite: vi.fn() }));
vi.mock("@metricflock/auth/mailer", () => ({ sendMail: vi.fn() }));
vi.mock("@metricflock/worker/scheduler", () => ({ startScheduler: mocks.startScheduler }));
vi.mock("@metricflock/worker/report", () => ({ sendOrgReport: vi.fn() }));

describe("worker index without a BullMQ connection", () => {
  let processExit: ReturnType<typeof vi.spyOn>;

  it("exits 1 when BullMQ has no connection options", async () => {
    process.env.WORKER_HEALTH_PORT = "18097";
    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    mocks.getRedis.mockImplementation(() => mocks.fakeRedis);
    mocks.bullConnectionOptions.mockReturnValue(null);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.startScheduler.mockReturnValue({ stop: mocks.schedulerStop });
    await import("@metricflock/worker/index");
    expect(mocks.logError).toHaveBeenCalledWith("REDIS_URL not set — workers cannot start");
    expect(processExit).toHaveBeenCalledWith(1);
  });

  it("shuts down gracefully on SIGINT", async () => {
    process.emit("SIGINT");
    const start = Date.now();
    while (!processExit.mock.calls.some((c: unknown[]) => c[0] === 0)) {
      if (Date.now() - start > 5000) throw new Error("shutdown did not reach process.exit(0)");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(mocks.logInfo).toHaveBeenCalledWith("shutting down gracefully", { signal: "SIGINT" });
    expect(mocks.schedulerStop).toHaveBeenCalledTimes(1);
    expect(mocks.workerClose).toHaveBeenCalledTimes(10);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.fakeRedis.disconnect).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
    processExit.mockRestore();
  });
});
