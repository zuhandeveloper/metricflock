import { describe, it, expect, vi, afterEach } from "vitest";
import { rateLimit } from "@metricflock/shared";

// No REDIS_URL in the unit-test env → the in-memory fallback path runs.
// The Redis Lua path is exercised in CI smoke (real Redis).
describe("rateLimit (in-memory fallback)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("allows up to the limit, then blocks", async () => {
    const key = `test:${Math.random()}`;
    expect(await rateLimit(key, 3, 60_000)).toEqual({ allowed: true, remaining: 2 });
    expect(await rateLimit(key, 3, 60_000)).toEqual({ allowed: true, remaining: 1 });
    expect(await rateLimit(key, 3, 60_000)).toEqual({ allowed: true, remaining: 0 });
    expect(await rateLimit(key, 3, 60_000)).toEqual({ allowed: false, remaining: 0 });
  });
  it("keys are independent", async () => {
    const a = `test:${Math.random()}`;
    const b = `test:${Math.random()}`;
    await rateLimit(a, 1, 60_000);
    expect((await rateLimit(a, 1, 60_000)).allowed).toBe(false);
    expect((await rateLimit(b, 1, 60_000)).allowed).toBe(true);
  });
  it("window expiry resets the bucket", async () => {
    // A-COV-12: fake timers — the in-memory limiter reads Date.now(), so
    // moving the fake clock past the window proves expiry deterministically
    // (the old version slept 5 ms of real time against a 1 ms window, a
    // race on loaded runners).
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const key = `test:${Math.random()}`;
    expect((await rateLimit(key, 1, 1_000)).allowed).toBe(true);
    // Still inside the window: blocked.
    expect((await rateLimit(key, 1, 1_000)).allowed).toBe(false);
    vi.setSystemTime(1_700_000_000_000 + 1_001);
    expect((await rateLimit(key, 1, 1_000)).allowed).toBe(true);
  });
});
