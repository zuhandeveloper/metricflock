import { describe, it, expect } from "vitest";
import { jitteredBackoffMs, JOB_PRIORITY } from "@metricflock/jobs";

// Phase 5 (F-5.5): exponential backoff with jitter. rand is injected so
// bounds are exact: factor 0.5 at rand=0, approaching 1.0 at rand→1.
// The pure function takes a 0-based retry index (0 = first retry);
// BullMQ passes its strategy argument 1-based, and the worker
// registration subtracts 1 — the effective schedule is asserted at the
// strategy level in worker-index.test.ts (A-WRK-13).
describe("jitteredBackoffMs", () => {
  it("doubles from a 60s base", () => {
    expect(jitteredBackoffMs(0, () => 0)).toBe(30_000);
    expect(jitteredBackoffMs(1, () => 0)).toBe(60_000);
    expect(jitteredBackoffMs(2, () => 0)).toBe(120_000);
    expect(jitteredBackoffMs(3, () => 0)).toBe(240_000);
  });
  it("stays within [50%, 100%) of the exponential base", () => {
    for (const attempts of [0, 1, 2, 4]) {
      const base = 60_000 * 2 ** attempts;
      expect(jitteredBackoffMs(attempts, () => 0)).toBe(Math.round(base * 0.5));
      expect(jitteredBackoffMs(attempts, () => 0.999)).toBeLessThan(base);
      expect(jitteredBackoffMs(attempts, () => 0.999)).toBeGreaterThan(base * 0.99);
    }
  });
  it("caps the base at one hour", () => {
    expect(jitteredBackoffMs(10, () => 0)).toBe(1_800_000);
    expect(jitteredBackoffMs(20, () => 0)).toBe(1_800_000);
  });
  it("treats negative attempts as the first attempt", () => {
    expect(jitteredBackoffMs(-3, () => 0)).toBe(30_000);
  });
});

describe("JOB_PRIORITY", () => {
  it("orders manual work ahead of scheduled sweeps (lower = sooner)", () => {
    expect(JOB_PRIORITY.MANUAL).toBeLessThan(JOB_PRIORITY.REQUEUE);
    expect(JOB_PRIORITY.REQUEUE).toBeLessThan(JOB_PRIORITY.REALTIME);
    expect(JOB_PRIORITY.REALTIME).toBeLessThan(JOB_PRIORITY.SCHEDULED);
  });
});
