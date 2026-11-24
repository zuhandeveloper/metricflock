import { describe, it, expect, vi } from "vitest";

// apps/worker/src/index.ts: with WORKER_HEALTH_PORT unset the health
// server listens on the default port 8080.
const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  getRedis: vi.fn(),
  bullConnectionOptions: vi.fn(),
  fakeRedis: { ping: vi.fn(async () => "PONG"), disconnect: vi.fn() },
}));

vi.mock("bullmq", () => {
  class MockWorker {
    constructor(name: string) {}
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
    $disconnect: vi.fn(async () => undefined),
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

describe("worker index with the default health port", () => {
  it("listens on port 8080 when WORKER_HEALTH_PORT is unset", async () => {
    delete process.env.WORKER_HEALTH_PORT;
    const processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    try {
      mocks.getRedis.mockImplementation(() => mocks.fakeRedis);
      mocks.bullConnectionOptions.mockReturnValue({ host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null });
      await import("@metricflock/worker/index");
      expect(processExit).not.toHaveBeenCalled();
      // healthServer.listen is async: wait for its callback to log.
      const start = Date.now();
      while (!mocks.logInfo.mock.calls.some((c: unknown[]) => c[0] === "health endpoint listening")) {
        if (Date.now() - start > 5000) throw new Error("health server did not start listening");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(mocks.logInfo).toHaveBeenCalledWith("health endpoint listening", { port: 8080 });
      // The server really is listening on 8080.
      const res = await fetch("http://127.0.0.1:8080/healthz");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    } finally {
      processExit.mockRestore();
    }
  });
});
