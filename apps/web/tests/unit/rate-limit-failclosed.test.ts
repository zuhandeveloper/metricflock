import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Phase 3 (F-3.1): with Redis CONFIGURED but unreachable, sensitive
// callers (failClosed) must be rejected, while non-sensitive callers
// degrade to per-process limiting. ioredis is mocked with a client whose
// eval always throws — deterministic, no sockets.
vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on() {
      return this;
    }
    async eval() {
      throw new Error("connection refused");
    }
  },
}));

describe("rateLimit with Redis configured but down", () => {
  const savedUrl = process.env.REDIS_URL;
  let rateLimit: typeof import("@metricflock/shared").rateLimit;
  let counterSnapshot: typeof import("@metricflock/shared").counterSnapshot;

  beforeAll(async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    vi.resetModules();
    const shared = await import("@metricflock/shared");
    rateLimit = shared.rateLimit;
    counterSnapshot = shared.counterSnapshot;
  });

  afterAll(() => {
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
    vi.resetModules();
  });

  it("failClosed callers are rejected when Redis is unreachable", async () => {
    const res = await rateLimit("test:failclosed", 10, 60_000, { failClosed: true });
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
    const counters = counterSnapshot();
    expect(counters["ratelimit.redis_error"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(counters["ratelimit.fail_closed"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("non-sensitive callers degrade to per-process limiting", async () => {
    const key = `test:degraded:${Math.random()}`;
    const first = await rateLimit(key, 1, 60_000);
    expect(first.allowed).toBe(true);
    const second = await rateLimit(key, 1, 60_000);
    expect(second.allowed).toBe(false);
    expect(counterSnapshot()["ratelimit.fallback"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
