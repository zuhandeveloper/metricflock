import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";

// packages/db/src/snapshots.ts (via its @metricflock/db/snapshots
// export) and packages/db/src/seed.ts. Both import the Prisma client
// through ./client; seed.ts has no package export (it is a script run
// via tsx), so it is imported by absolute path and only via dynamic
// import: main() runs at import time, so env + mocks must be set
// first and the module registry reset per test. The seed guard itself
// is covered by seed-guard.test.ts.
const mocks = vi.hoisted(() => ({
  analyticsUpsert: vi.fn(),
  analyticsFindUnique: vi.fn(),
  analyticsFindMany: vi.fn(),
  analyticsDeleteMany: vi.fn(),
  orgUpsert: vi.fn(),
  userUpsert: vi.fn(),
  accountFindFirst: vi.fn(),
  accountCreate: vi.fn(),
  teamUpsert: vi.fn(),
  websiteUpsert: vi.fn(),
  disconnect: vi.fn(),
  hashPassword: vi.fn(),
}));

// better-auth/crypto cannot be mocked by bare specifier: pnpm gives
// packages/db its own better-auth copy, which the web app cannot even
// resolve, so such a mock silently misses and the real scrypt
// hashPassword runs instead. Mock it by resolved real path.
function registerCryptoMock() {
  const requireFromDb = createRequire(path.resolve(process.cwd(), "../../packages/db/src/seed.ts"));
  const cryptoPath = fs.realpathSync(requireFromDb.resolve("better-auth/crypto"));
  vi.doMock(cryptoPath, () => ({ hashPassword: mocks.hashPassword }));
}

// Both target modules import the Prisma client through ./client, which
// is mocked here by computed absolute path: a relative vi.mock path
// resolves against the wrong base for files outside the web root and
// silently misses, so the mock is registered with vi.doMock (not
// hoisted, so a computed path works) and both modules are imported
// dynamically after it. Mocking "@metricflock/db" would miss, because
// neither module imports that specifier.
const CLIENT_PATH = path.resolve(process.cwd(), "../../packages/db/src/client.ts");
function registerClientMock() {
  vi.doMock(CLIENT_PATH, () => ({
    prisma: {
      analyticsCache: {
        upsert: mocks.analyticsUpsert,
        findUnique: mocks.analyticsFindUnique,
        findMany: mocks.analyticsFindMany,
        deleteMany: mocks.analyticsDeleteMany,
      },
      organization: { upsert: mocks.orgUpsert },
      user: { upsert: mocks.userUpsert },
      account: { findFirst: mocks.accountFindFirst, create: mocks.accountCreate },
      team: { upsert: mocks.teamUpsert },
      website: { upsert: mocks.websiteUpsert },
      $disconnect: mocks.disconnect,
    },
  }));
}

type SnapshotsModule = typeof import("@metricflock/db/snapshots");
let snapshots: SnapshotsModule;

async function loadSnapshots(): Promise<SnapshotsModule> {
  registerClientMock();
  vi.resetModules();
  snapshots = await import("@metricflock/db/snapshots");
  return snapshots;
}

describe("snapshots (packages/db/src/snapshots.ts)", () => {
  beforeAll(async () => {
    await loadSnapshots();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analyticsUpsert.mockResolvedValue({});
    mocks.analyticsFindUnique.mockResolvedValue(null);
    mocks.analyticsFindMany.mockResolvedValue([]);
    mocks.analyticsDeleteMany.mockResolvedValue({ count: 0 });
    mocks.disconnect.mockResolvedValue(undefined);
  });

  it("writeSnapshot upserts the cache key with a TTL-derived expiry", async () => {
    const before = Date.now();
    await snapshots.writeSnapshot("cache-key-1", "site-1", { rows: [1] }, 300);
    const after = Date.now();
    expect(mocks.analyticsUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.analyticsUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ cacheKey: "cache-key-1" });
    expect(args.update.payload).toEqual({ rows: [1] });
    expect(args.update.websiteId).toBe("site-1");
    expect(args.create).toEqual({
      cacheKey: "cache-key-1",
      websiteId: "site-1",
      payload: { rows: [1] },
      expiresAt: args.update.expiresAt,
    });
    const expiresMs = (args.update.expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 300_000);
    expect(expiresMs).toBeLessThanOrEqual(after + 300_000);
  });

  it("readSnapshot returns payload + expiry + updatedAt for a stored row", async () => {
    const expiresAt = new Date("2026-11-20T00:00:00Z");
    const createdAt = new Date("2026-11-19T00:00:00Z");
    mocks.analyticsFindUnique.mockResolvedValue({ payload: { clicks: 5 }, expiresAt, createdAt });
    await expect(snapshots.readSnapshot("cache-key-1")).resolves.toEqual({
      payload: { clicks: 5 },
      expiresAt,
      updatedAt: createdAt,
    });
    expect(mocks.analyticsFindUnique).toHaveBeenCalledWith({
      where: { cacheKey: "cache-key-1" },
      select: { payload: true, expiresAt: true, createdAt: true },
    });
  });

  it("readSnapshot returns null when there is no row", async () => {
    await expect(snapshots.readSnapshot("missing-key")).resolves.toBeNull();
  });

  // A-DB-11: the batch read — one findMany for any number of keys.
  it("readSnapshots returns one map entry per row from a single findMany", async () => {
    const expiresAt = new Date("2026-11-20T00:00:00Z");
    const createdAt = new Date("2026-11-19T00:00:00Z");
    mocks.analyticsFindMany.mockResolvedValue([
      { cacheKey: "k1", payload: { clicks: 5 }, expiresAt, createdAt },
      { cacheKey: "k2", payload: { clicks: 9 }, expiresAt, createdAt },
    ]);
    const out = await snapshots.readSnapshots(["k1", "k2", "k3"]);
    expect(mocks.analyticsFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.analyticsFindMany).toHaveBeenCalledWith({
      where: { cacheKey: { in: ["k1", "k2", "k3"] } },
      select: { cacheKey: true, payload: true, expiresAt: true, createdAt: true },
    });
    expect(out.get("k1")).toEqual({ payload: { clicks: 5 }, expiresAt, updatedAt: createdAt });
    expect(out.get("k2")).toEqual({ payload: { clicks: 9 }, expiresAt, updatedAt: createdAt });
    expect(out.has("k3")).toBe(false);
  });

  it("readSnapshots returns an empty map without querying for no keys", async () => {
    await expect(snapshots.readSnapshots([])).resolves.toEqual(new Map());
    expect(mocks.analyticsFindMany).not.toHaveBeenCalled();
  });

  it("invalidateWebsiteSnapshots deletes every snapshot for the website", async () => {
    await snapshots.invalidateWebsiteSnapshots("site-1");
    expect(mocks.analyticsDeleteMany).toHaveBeenCalledWith({ where: { websiteId: "site-1" } });
  });

  it("invalidateWebsiteSnapshots swallows delete failures", async () => {
    mocks.analyticsDeleteMany.mockRejectedValue(new Error("db down"));
    await expect(snapshots.invalidateWebsiteSnapshots("site-1")).resolves.toBeUndefined();
  });

  it("invalidateOrgSnapshots deletes by the analytics:org: key prefix", async () => {
    await snapshots.invalidateOrgSnapshots("org-1");
    expect(mocks.analyticsDeleteMany).toHaveBeenCalledWith({
      where: { cacheKey: { startsWith: "analytics:org-1:" } },
    });
  });

  it("invalidateOrgSnapshots swallows delete failures", async () => {
    mocks.analyticsDeleteMany.mockRejectedValue(new Error("db down"));
    await expect(snapshots.invalidateOrgSnapshots("org-1")).resolves.toBeUndefined();
  });
});

describe("seed (packages/db/src/seed.ts)", () => {
  const savedEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const LOCAL_URL = "postgresql://user:pass@localhost:5432/db";
  const REMOTE_URL = "postgresql://user:pass@db.example.com:5432/db";

  async function runSeed() {
    registerClientMock();
    registerCryptoMock();
    vi.resetModules();
    // Vitest resolves a relative specifier against the wrong base for
    // files outside the web root, so import by absolute path.
    await import(path.resolve(process.cwd(), "../../packages/db/src/seed.ts"));
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalled(), { timeout: 5000 });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.orgUpsert.mockResolvedValue({ id: "org-1" });
    mocks.userUpsert.mockResolvedValue({ id: "user-1" });
    mocks.accountFindFirst.mockResolvedValue({ id: "acc-1" });
    mocks.accountCreate.mockResolvedValue({ id: "acc-1" });
    mocks.teamUpsert.mockImplementation(async (args: { where: { organizationId_slug: { slug: string } } }) => ({
      id: args.where.organizationId_slug.slug === "team-a" ? "team-a" : "team-b",
    }));
    mocks.websiteUpsert.mockResolvedValue({});
    mocks.hashPassword.mockResolvedValue("hashed-pw");
    mocks.disconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("seeds org, demo admin, teams and example sites when the account already exists", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("SEED_DEMO_ADMIN_PASSWORD", "test-seed-password-123");
    await runSeed();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.orgUpsert).toHaveBeenCalledWith({
      where: { slug: "main-org" },
      update: {},
      create: { name: "Main Organization", slug: "main-org" },
    });
    expect(mocks.userUpsert).toHaveBeenCalledWith({
      where: { email: "demo@example.com" },
      update: {},
      create: expect.objectContaining({
        organizationId: "org-1",
        email: "demo@example.com",
        name: "Super Admin",
        emailVerified: true,
        role: "SUPER_ADMIN",
      }),
    });
    // Idempotent: the credential account is only created once.
    expect(mocks.accountCreate).not.toHaveBeenCalled();
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.teamUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.websiteUpsert).toHaveBeenCalledTimes(3);
    const siteCalls = mocks.websiteUpsert.mock.calls.map((c) => c[0]);
    expect(siteCalls[0].create.domain).toBe("cottagefood.example.com");
    expect(siteCalls[0].create.teamId).toBe("team-a");
    expect(siteCalls[1].create.domain).toBe("evcharger.example.com");
    expect(siteCalls[1].create.teamId).toBe("team-a");
    expect(siteCalls[2].create.domain).toBe("homekitchenlaw.example.com");
    expect(siteCalls[2].create.teamId).toBe("team-b");
    expect(siteCalls[0].where).toEqual({
      organizationId_domain: { organizationId: "org-1", domain: "cottagefood.example.com" },
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Seed complete"));
    expect(mocks.disconnect).toHaveBeenCalled();
  });

  it("creates the credential account with the env password when none exists", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("SEED_DEMO_ADMIN_PASSWORD", "test-seed-password-123");
    mocks.accountFindFirst.mockResolvedValue(null);
    await runSeed();

    expect(mocks.hashPassword).toHaveBeenCalledWith("test-seed-password-123");
    expect(mocks.accountCreate).toHaveBeenCalledWith({
      data: {
        accountId: "user-1",
        providerId: "credential",
        userId: "user-1",
        password: "hashed-pw",
      },
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses to run against a remote target without a password (guard failure)", async () => {
    vi.stubEnv("DATABASE_URL", REMOTE_URL);
    delete process.env.SEED_DEMO_ADMIN_PASSWORD;
    await runSeed();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("refusing to seed"));
  });

  it("exits 1 and disconnects when a seed upsert fails", async () => {
    vi.stubEnv("DATABASE_URL", LOCAL_URL);
    vi.stubEnv("SEED_DEMO_ADMIN_PASSWORD", "test-seed-password-123");
    mocks.orgUpsert.mockRejectedValue(new Error("db down"));
    await runSeed();

    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.disconnect).toHaveBeenCalled();
  });
});
