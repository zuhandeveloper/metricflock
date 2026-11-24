import { describe, expect, it } from "vitest";
// The guard is a pure module (no Prisma import) so it can be tested
// without a database.
import { isLocalDatabaseUrl, checkSeedTarget } from "@metricflock/db/seed-guard";

// A-SEC-03: the seed must refuse a remote-looking target database
// unless SEED_ALLOW_REMOTE=1 is set explicitly, and must refuse to run
// without a password from SEED_DEMO_ADMIN_PASSWORD — regardless of
// NODE_ENV (the old footgun keyed the refusal off NODE_ENV, not the
// target, so NODE_ENV unset + a remote DATABASE_URL created a
// known-credential SUPER_ADMIN in that database).
describe("isLocalDatabaseUrl", () => {
  it("accepts loopback hosts", () => {
    expect(isLocalDatabaseUrl("postgresql://user:pass@localhost:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://user:pass@127.0.0.1:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://user:pass@[::1]:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://user:pass@app.localhost:5432/db")).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLocalDatabaseUrl("postgresql://user:pass@db.example.com:5432/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://user:pass@10.0.0.5:5432/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://user:pass@postgres.railway.internal:5432/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://user:pass@db:5432/db")).toBe(false);
  });

  it("fails closed on missing or unparsable URLs", () => {
    expect(isLocalDatabaseUrl(undefined)).toBe(false);
    expect(isLocalDatabaseUrl("")).toBe(false);
    expect(isLocalDatabaseUrl("not-a-url")).toBe(false);
  });
});

describe("checkSeedTarget", () => {
  const local = "postgresql://user:pass@localhost:5432/db";
  const remote = "postgresql://user:pass@db.example.com:5432/db";

  it("allows a local target with a password from env", () => {
    expect(checkSeedTarget({ databaseUrl: local, password: "some-private-password" })).toEqual({
      ok: true,
      password: "some-private-password",
    });
  });

  it("refuses a remote-looking URL without an explicit override", () => {
    const result = checkSeedTarget({ databaseUrl: remote, password: "some-private-password" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/non-local/);
  });

  it("allows a remote target only with SEED_ALLOW_REMOTE=1", () => {
    expect(checkSeedTarget({ databaseUrl: remote, allowRemote: true, password: "x" }).ok).toBe(true);
    expect(checkSeedTarget({ databaseUrl: remote, allowRemote: false, password: "x" }).ok).toBe(false);
  });

  it("refuses without a password even against a local target (no default password)", () => {
    for (const password of [undefined, null, ""]) {
      const result = checkSeedTarget({ databaseUrl: local, password });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/SEED_DEMO_ADMIN_PASSWORD/);
    }
  });

  it("refuses when the target URL is missing (cannot verify locality)", () => {
    expect(checkSeedTarget({ password: "x" }).ok).toBe(false);
    expect(checkSeedTarget({ databaseUrl: undefined, allowRemote: true, password: "x" }).ok).toBe(true);
  });
});
