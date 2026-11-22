import { describe, it, expect } from "vitest";
import { acquireRefreshLock } from "@metricflock/google/tokens";

// Phase 3 (F-3.2): refresh-lock acquisition outcomes. The caller fails
// closed on "timeout" and "error" — these tests pin the distinction so
// an unlocked refresh can never silently come back.
type FakeRedis = {
  set: (key: string, value: string, mode: string, ttl: number, nx: string) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  eval: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
};

const opts = { ttlMs: 1000, deadlineMs: 60, pollMs: 5 };

describe("acquireRefreshLock", () => {
  it("acquires when the key is free", async () => {
    const redis: FakeRedis = {
      set: async () => "OK",
      get: async () => null,
      eval: async () => 0,
    };
    expect(await acquireRefreshLock(redis, "k", "tok", opts)).toBe("acquired");
  });

  it("times out when another holder never releases", async () => {
    const redis: FakeRedis = {
      set: async () => null,
      get: async () => "other",
      eval: async () => 0,
    };
    expect(await acquireRefreshLock(redis, "k", "tok", opts)).toBe("timeout");
  });

  it("reports error (not timeout) when Redis throws", async () => {
    const redis: FakeRedis = {
      set: async () => {
        throw new Error("connection refused");
      },
      get: async () => null,
      eval: async () => 0,
    };
    expect(await acquireRefreshLock(redis, "k", "tok", opts)).toBe("error");
  });

  it("acquires after the holder releases mid-wait", async () => {
    let calls = 0;
    const redis: FakeRedis = {
      set: async () => (++calls >= 3 ? "OK" : null),
      get: async () => null,
      eval: async () => 0,
    };
    expect(await acquireRefreshLock(redis, "k", "tok", opts)).toBe("acquired");
    expect(calls).toBe(3);
  });
});
