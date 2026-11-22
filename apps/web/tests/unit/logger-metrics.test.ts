import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, errMeta, incr, counterSnapshot, resetCounters } from "@metricflock/shared";

describe("structured logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits one JSON line with ts/level/context/msg and meta", () => {
    createLogger("test").info("hello", { requestId: "r-1", n: 2 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(parsed.level).toBe("info");
    expect(parsed.context).toBe("test");
    expect(parsed.msg).toBe("hello");
    expect(parsed.requestId).toBe("r-1");
    expect(parsed.n).toBe(2);
    expect(typeof parsed.ts).toBe("string");
  });

  it("routes warn/error to stderr and child() merges base meta", () => {
    const child = createLogger("api").child({ requestId: "r-9" });
    child.error("boom", { route: "x" });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(errSpy.mock.calls[0][0]));
    expect(parsed.level).toBe("error");
    expect(parsed.requestId).toBe("r-9");
    expect(parsed.route).toBe("x");
  });

  it("errMeta normalizes Errors and non-Errors", () => {
    expect(errMeta(new Error("nope"))).toEqual({ error: "nope" });
    expect(errMeta("plain")).toEqual({ error: "plain" });
  });
});

describe("metrics counters", () => {
  beforeEach(() => resetCounters());
  it("increments and snapshots sorted", () => {
    incr("cache.hit");
    incr("cache.hit", 2);
    incr("cache.miss");
    expect(counterSnapshot()).toEqual({ "cache.hit": 3, "cache.miss": 1 });
  });
});
