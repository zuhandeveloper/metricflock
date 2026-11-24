import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Coverage-gap closure: packages/shared/src/env.ts — getEnv validation
// + build placeholder branch, googleEnabled flags. getEnv caches its
// result in module state, so the module is re-imported per test.
type Shared = typeof import("@metricflock/shared");

async function loadShared(): Promise<Shared> {
  vi.resetModules();
  return import("@metricflock/shared");
}

const KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "NEXT_PHASE",
  "GOOGLE_ANALYTICS_ENABLED",
  "GOOGLE_SEARCH_CONSOLE_ENABLED",
  "GOOGLE_ADSENSE_ENABLED",
  "GOOGLE_AD_MANAGER_ENABLED",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/db";
  process.env.SESSION_SECRET = "test-secret-at-least-32-characters!!";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe("getEnv", () => {
  it("returns the parsed env (required + optional passthrough)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.GOOGLE_CLIENT_ID = "cid";
    const shared = await loadShared();
    const env = shared.getEnv();
    expect(env.DATABASE_URL).toBe("postgresql://user:pass@127.0.0.1:1/db");
    expect(env.SESSION_SECRET).toBe("test-secret-at-least-32-characters!!");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(shared.getEnv()).toBe(env); // cached instance
  });
  it("missing DATABASE_URL → throws naming the field", async () => {
    delete process.env.DATABASE_URL;
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/Invalid environment:.*DATABASE_URL/);
  });
  it("short SESSION_SECRET → throws naming the field", async () => {
    process.env.SESSION_SECRET = "too-short";
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/SESSION_SECRET must be at least 32 chars/);
  });
  it("short BETTER_AUTH_SECRET → throws", async () => {
    process.env.BETTER_AUTH_SECRET = "short";
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/BETTER_AUTH_SECRET must be at least 32 chars/);
  });
  it("production-build phase → placeholder env instead of throwing", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    process.env.NEXT_PHASE = "phase-production-build";
    const shared = await loadShared();
    const env = shared.getEnv();
    expect(env.DATABASE_URL).toContain("placeholder");
    expect(env.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});

describe("googleEnabled", () => {
  it("defaults to true; explicit 'false' disables; anything else enables", async () => {
    const shared = await loadShared();
    expect(shared.googleEnabled("ANALYTICS")).toBe(true);
    expect(shared.googleEnabled("AD_MANAGER")).toBe(true);
    process.env.GOOGLE_ANALYTICS_ENABLED = "false";
    process.env.GOOGLE_ADSENSE_ENABLED = "true";
    process.env.GOOGLE_SEARCH_CONSOLE_ENABLED = "yes";
    expect(shared.googleEnabled("ANALYTICS")).toBe(false);
    expect(shared.googleEnabled("ADSENSE")).toBe(true);
    expect(shared.googleEnabled("SEARCH_CONSOLE")).toBe(true);
    process.env.GOOGLE_AD_MANAGER_ENABLED = "false";
    expect(shared.googleEnabled("AD_MANAGER")).toBe(false);
  });
});
