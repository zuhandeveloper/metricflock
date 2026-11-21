import { describe, it, expect } from "vitest";
import { rateLimit } from "@metricflock/shared";

// No REDIS_URL in the unit-test env → the in-memory fallback path runs.
// The Redis Lua path is exercised in CI smoke (real Redis).
describe("rateLimit (in-memory fallback)", () => {
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
    const key = `test:${Math.random()}`;
    expect((await rateLimit(key, 1, 1)).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect((await rateLimit(key, 1, 1)).allowed).toBe(true);
  });
});
