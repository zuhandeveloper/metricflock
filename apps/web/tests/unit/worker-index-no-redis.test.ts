import { describe, it, expect, vi } from "vitest";

// apps/worker/src/index.ts, REDIS_URL-missing path: with no Redis the
// worker logs the error and exits 1 at import time. process.exit is
// spied (not real) so the module keeps evaluating under test; the
// assertion is that exit(1) was requested.
const mocks = vi.hoisted(() => ({
  workers: [] as Record<string, unknown>[],
  getRedis: vi.fn(),
  bullConnectionOptions: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  fakeRedis: { ping: vi.fn(async () => "PONG"), disconnect: vi.fn() },
}));

vi.mock("bullmq", () => {
  class MockWorker {
    constructor(name: string) {
      mocks.workers.push({ name });
    }
    on() {
      return this;
    }
    close = vi.fn(async () => undefined);
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
    $disconnect: vi.fn(),
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
vi.mock("@metricflock/worker/scheduler", () => ({ startScheduler: vi.fn(() => ({ stop: vi.fn() })) }));
vi.mock("@metricflock/worker/report", () => ({ sendOrgReport: vi.fn() }));

describe("worker index without Redis", () => {
  it("logs the missing Redis error and exits 1 instead of starting workers", async () => {
    process.env.WORKER_HEALTH_PORT = "18098";
    const processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    try {
      mocks.getRedis.mockReturnValue(null);
      mocks.bullConnectionOptions.mockReturnValue({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null });
      await import("@metricflock/worker/index");
      expect(mocks.logError).toHaveBeenCalledWith("REDIS_URL not set — workers cannot start");
      expect(processExit).toHaveBeenCalledWith(1);
      expect(processExit).toHaveBeenCalledTimes(1);
    } finally {
      processExit.mockRestore();
    }
  });
});
