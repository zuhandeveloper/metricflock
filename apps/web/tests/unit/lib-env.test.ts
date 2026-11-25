import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Coverage-gap closure: packages/shared/src/env.ts — getEnv validation
// + build placeholder branch, googleEnabled flags. getEnv caches its
// result in module state, so the module is re-imported per test.
type Shared = typeof import("@metricflock/shared");

async function loadShared(): Promise<Shared> {
  vi.resetModules();
  return import("@metricflock/shared");
}

// process.env.NODE_ENV is typed readonly in @types/node — assign via a cast.
function setNodeEnv(value: string) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
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
  // A-COV-07: the "returns the parsed env" test sets GOOGLE_CLIENT_ID;
  // without it in KEYS the value leaked into later tests (caught by the
  // "optional fields absent → undefined" test). All optional keys the
  // schema knows are cleaned so each test sees controlled env vars.
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
  "GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "NEXT_PUBLIC_APP_URL",
  // A-SEC-14: the production key-requirement tests set NODE_ENV, and the
  // startup tests set NEXT_RUNTIME; both are restored by afterEach.
  "NODE_ENV",
  "NEXT_RUNTIME",
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
    // Cast: KEYS now includes NODE_ENV, which @types/node types readonly.
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
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
  it("empty-string DATABASE_URL → throws (min length 1)", async () => {
    process.env.DATABASE_URL = "";
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/DATABASE_URL/);
  });
  it("optional fields absent → undefined (no phantom defaults)", async () => {
    const shared = await loadShared();
    const env = shared.getEnv();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
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
  it("only exact lowercase 'false' disables ('FALSE' / '0' stay enabled)", async () => {
    const shared = await loadShared();
    process.env.GOOGLE_ANALYTICS_ENABLED = "FALSE";
    process.env.GOOGLE_ADSENSE_ENABLED = "0";
    expect(shared.googleEnabled("ANALYTICS")).toBe(true);
    expect(shared.googleEnabled("ADSENSE")).toBe(true);
  });
});

// A-SEC-14: in production the token-encryption key must be present and
// valid at boot — the app must not serve traffic and fail only at the
// first Google connect (after the token exchange).
describe("getEnv production encryption-key requirement (A-SEC-14)", () => {
  // CI dummy key (also in .github/workflows/ci.yml): base64 of bytes 0..31.
  const VALID_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

  it("production + key unset → throws naming the key", async () => {
    setNodeEnv("production");
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY.*32 bytes/);
  });

  it("production + key not valid base64 → throws", async () => {
    setNodeEnv("production");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = "not-a-key!!";
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY.*32 bytes/);
  });

  it("production + key base64 of 16 bytes → throws", async () => {
    setNodeEnv("production");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString("base64");
    const shared = await loadShared();
    expect(() => shared.getEnv()).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY.*32 bytes/);
  });

  it("production + valid 32-byte key → does not throw", async () => {
    setNodeEnv("production");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = VALID_KEY;
    const shared = await loadShared();
    expect(shared.getEnv().GOOGLE_TOKEN_ENCRYPTION_KEY).toBe(VALID_KEY);
  });

  it("non-production + key unset → does not throw (existing behaviour)", async () => {
    setNodeEnv("test");
    const shared = await loadShared();
    expect(shared.getEnv().GOOGLE_TOKEN_ENCRYPTION_KEY).toBeUndefined();
  });

  it("production-build phase + key unset → placeholder (build not broken)", async () => {
    setNodeEnv("production");
    process.env.NEXT_PHASE = "phase-production-build";
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    const shared = await loadShared();
    expect(shared.getEnv().DATABASE_URL).toContain("placeholder");
  });
});

// A-SEC-14 (SMTP half): the finding allows "fail boot (or at least emit a
// startup error)". Revalidation found instrumentation.ts already logs an
// ERROR (not a warning) in production when SMTP_HOST is unset, with the
// consequence named — these tests pin that behaviour, and the production
// boot-failure path through register() when the key is missing.
describe("startup checks (A-SEC-14)", () => {
  const VALID_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

  async function loadInstrumentation() {
    vi.resetModules();
    return import("../../src/instrumentation");
  }

  function productionEnv() {
    setNodeEnv("production");
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = VALID_KEY;
  }

  it("production without SMTP_HOST → startup ERROR naming SMTP_HOST, boot continues", async () => {
    productionEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { register } = await loadInstrumentation();
      await expect(register()).resolves.toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("SMTP_HOST is not configured"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("production with SMTP_HOST → no SMTP startup error", async () => {
    productionEnv();
    process.env.SMTP_HOST = "smtp.example.com";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { register } = await loadInstrumentation();
      await expect(register()).resolves.toBeUndefined();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("SMTP_HOST is not configured"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("production without the encryption key → register() rejects (boot fails)", async () => {
    productionEnv();
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    const { register } = await loadInstrumentation();
    await expect(register()).rejects.toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY.*32 bytes/);
  });
});
