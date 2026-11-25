// A-PERF-01: regression tests for the load-test script's pure helpers.
// No network is touched here — the script itself is only ever run against
// a staging deploy with the owner's explicit approval.
import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_ENDPOINTS,
  PUBLIC_ENDPOINTS,
  STAGES,
  buildPlan,
  computePercentiles,
  isProductionHost,
  parseArgs,
  validateTarget,
} from "../../scripts/load-test.mjs";

describe("computePercentiles", () => {
  it("returns nulls for an empty sample", () => {
    expect(computePercentiles([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it("uses nearest-rank percentiles on 1..100", () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = computePercentiles(latencies);
    expect(stats.count).toBe(100);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(50.5);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
  });

  it("handles a single sample", () => {
    expect(computePercentiles([42])).toMatchObject({ count: 1, min: 42, max: 42, p50: 42, p95: 42, p99: 42 });
  });
});

describe("isProductionHost", () => {
  it("flags every production host", () => {
    for (const host of [
      "metricflock.bond",
      "metricflock.vercel.app",
      "metricflock-zuhan4.vercel.app",
      "metricflock-git-main-zuhan4.vercel.app",
    ]) {
      expect(isProductionHost(host)).toBe(true);
    }
  });

  it("allows staging targets", () => {
    for (const host of ["metricflock-abc123-zuhan4.vercel.app", "staging.example.com", "localhost", "127.0.0.1"]) {
      expect(isProductionHost(host)).toBe(false);
    }
  });

  it("is case-insensitive", () => {
    expect(isProductionHost("MetricFlock.Bond")).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses the full form", () => {
    expect(
      parseArgs([
        "--url",
        "https://staging.example.com",
        "--seconds",
        "10",
        "--max-error-rate",
        "2",
        "--json",
        "--dry-run",
      ]),
    ).toEqual({
      seconds: 10,
      maxErrorRate: 2,
      dryRun: true,
      json: true,
      url: "https://staging.example.com",
      out: null,
    });
  });

  it("defaults to 30s stages and a 1% error budget", () => {
    expect(parseArgs(["--url", "https://staging.example.com"])).toMatchObject({
      seconds: 30,
      maxErrorRate: 1,
      dryRun: false,
    });
  });

  it("rejects a missing --url, a bad --seconds, and unknown flags", () => {
    expect(() => parseArgs([])).toThrow("--url");
    expect(() => parseArgs(["--url", "https://x.example", "--seconds", "0"])).toThrow("--seconds");
    expect(() => parseArgs(["--url", "https://x.example", "--bogus"])).toThrow("unknown argument");
  });
});

describe("validateTarget", () => {
  it("refuses to run without LOAD_TEST_CONFIRM=1", () => {
    expect(() => validateTarget("https://staging.example.com")).toThrow("LOAD_TEST_CONFIRM=1");
    expect(() => validateTarget("https://staging.example.com", "0")).toThrow("LOAD_TEST_CONFIRM=1");
  });

  it("refuses every production host even when confirmed", () => {
    for (const host of [
      "metricflock.bond",
      "metricflock.vercel.app",
      "metricflock-zuhan4.vercel.app",
      "metricflock-git-main-zuhan4.vercel.app",
    ]) {
      expect(() => validateTarget(`https://${host}`, "1")).toThrow("production host");
    }
  });

  it("refuses http for remote targets but allows localhost", () => {
    expect(() => validateTarget("http://staging.example.com", "1")).toThrow("https");
    expect(validateTarget("http://localhost:3000", "1").hostname).toBe("localhost");
  });

  it("accepts a confirmed https staging URL", () => {
    expect(validateTarget("https://metricflock-abc123-zuhan4.vercel.app", "1").hostname).toBe(
      "metricflock-abc123-zuhan4.vercel.app",
    );
  });
});

describe("buildPlan", () => {
  it("ramps 10 -> 50 -> 100 with the four public endpoints", () => {
    const plan = buildPlan({ url: new URL("https://staging.example.com"), seconds: 30 });
    expect(plan.stages).toEqual(STAGES);
    expect(plan.endpoints).toEqual(PUBLIC_ENDPOINTS);
    expect(plan.authenticated).toBe(false);
  });

  it("adds the authenticated endpoints only with a cookie (and the overview only with a website id)", () => {
    const base = { url: new URL("https://staging.example.com"), seconds: 30, cookie: "session=abc" };
    const withoutWebsite = buildPlan(base);
    expect(withoutWebsite.authenticated).toBe(true);
    expect(withoutWebsite.endpoints.map((e) => e.label)).toEqual([
      "health",
      "health-ready",
      "login-page",
      "root",
      "dashboard",
      "websites-api",
    ]);
    const withWebsite = buildPlan({ ...base, websiteId: "w1" });
    expect(withWebsite.endpoints.map((e) => e.label)).toContain("analytics-overview");
    expect(withWebsite.endpoints.find((e) => e.label === "analytics-overview")?.path).toBe(
      "/api/analytics/overview?websiteId=w1",
    );
  });

  it("keeps the authenticated endpoints out of scope for the AUTHENTICATED_ENDPOINTS list itself", () => {
    expect(AUTHENTICATED_ENDPOINTS.map((e) => e.label)).toEqual(["dashboard", "websites-api", "analytics-overview"]);
  });
});
