import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Coverage-gap closure: packages/shared/src/cache.ts — getRedis,
// bullConnectionOptions, cacheGet/cacheSet, invalidateWebsiteCache /
// invalidateOrgCache (SCAN-based). ioredis is mocked (same alias the
// vitest config maps it through); the module is re-imported per test
// group because getRedis caches its client in module state.
const mocks = vi.hoisted(() => ({
  instances: [] as FakeRedis[],
  ctorShouldThrow: false,
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisScan: vi.fn(),
  redisDel: vi.fn(),
}));

class FakeRedis {
  url: string;
  opts: unknown;
  constructor(url: string, opts: unknown) {
    if (mocks.ctorShouldThrow) throw new Error("ctor boom");
    this.url = url;
    this.opts = opts;
    mocks.instances.push(this);
  }
  on() {
    return this;
  }
  async get(key: string) {
    return mocks.redisGet(key);
  }
  async set(...args: unknown[]) {
    return mocks.redisSet(...args);
  }
  async scan(...args: unknown[]) {
    return mocks.redisScan(...args);
  }
  async del(...args: unknown[]) {
    return mocks.redisDel(...args);
  }
}

vi.mock("ioredis", () => ({ default: FakeRedis }));

type Shared = typeof import("@metricflock/shared");

async function loadShared(): Promise<Shared> {
  vi.resetModules();
  return import("@metricflock/shared");
}

const savedRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instances.length = 0;
  mocks.ctorShouldThrow = false;
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSet.mockResolvedValue("OK");
  mocks.redisDel.mockResolvedValue(1);
});

afterEach(() => {
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  vi.resetModules();
});

describe("getRedis", () => {
  it("no REDIS_URL → null (caching degrades to no-op)", async () => {
    delete process.env.REDIS_URL;
    const shared = await loadShared();
    expect(shared.getRedis()).toBeNull();
    expect(await shared.cacheGet("k")).toBeNull();
    await shared.cacheSet("k", { a: 1 }, 60);
    expect(mocks.redisSet).not.toHaveBeenCalled();
  });
  it("with REDIS_URL → one lazy client, constructed once, options pinned", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    const first = shared.getRedis();
    const second = shared.getRedis();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0].url).toBe("redis://127.0.0.1:6379");
    expect(mocks.instances[0].opts).toEqual({
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
  });
  it("constructor throwing → null (degrade, don't crash boot)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    mocks.ctorShouldThrow = true;
    const shared = await loadShared();
    expect(shared.getRedis()).toBeNull();
  });
});

describe("bullConnectionOptions", () => {
  it("no REDIS_URL → null (queues disabled)", async () => {
    delete process.env.REDIS_URL;
    const shared = await loadShared();
    expect(shared.bullConnectionOptions()).toBeNull();
  });
  it("parses host/port/user/pass; rediss adds tls; default port 6379", async () => {
    const shared = await loadShared();
    process.env.REDIS_URL = "redis://user:secret@redis.example:6380";
    expect(shared.bullConnectionOptions()).toEqual({
      host: "redis.example",
      port: 6380,
      password: "secret",
      username: "user",
      maxRetriesPerRequest: null,
    });
    process.env.REDIS_URL = "rediss://127.0.0.1";
    expect(shared.bullConnectionOptions()).toEqual({
      host: "127.0.0.1",
      port: 6379,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });
  it("invalid URL → null", async () => {
    process.env.REDIS_URL = "not a url at all :::";
    const shared = await loadShared();
    expect(shared.bullConnectionOptions()).toBeNull();
  });
});

describe("cacheGet / cacheSet", () => {
  it("miss → null; hit fresh → value + stale:false; stale → stale:true", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    expect(await shared.cacheGet("k")).toBeNull();
    mocks.redisGet.mockResolvedValueOnce(JSON.stringify({ value: { rows: [1] }, expiresAt: Date.now() + 60_000 }));
    expect(await shared.cacheGet("k")).toEqual({ value: { rows: [1] }, stale: false });
    mocks.redisGet.mockResolvedValueOnce(JSON.stringify({ value: "old", expiresAt: Date.now() - 1000 }));
    expect(await shared.cacheGet("k")).toEqual({ value: "old", stale: true });
  });
  it("redis error / corrupt JSON → null (best-effort, never throws)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    mocks.redisGet.mockRejectedValueOnce(new Error("down"));
    expect(await shared.cacheGet("k")).toBeNull();
    mocks.redisGet.mockResolvedValueOnce("not-json{{");
    expect(await shared.cacheGet("k")).toBeNull();
  });
  it("cacheSet writes JSON envelope with doubled EX ttl; set error swallowed", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    await shared.cacheSet("k", { v: 1 }, 300);
    expect(mocks.redisSet).toHaveBeenCalledWith("k", expect.stringContaining('"v":1'), "EX", 600);
    const stored = JSON.parse(mocks.redisSet.mock.calls[0][1] as string) as { expiresAt: number };
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    mocks.redisSet.mockRejectedValueOnce(new Error("down"));
    await expect(shared.cacheSet("k", { v: 2 }, 300)).resolves.toBeUndefined();
  });
});

describe("invalidateWebsiteCache / invalidateOrgCache", () => {
  it("SCANs in cursor pages and DELs every batch", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    mocks.redisScan
      .mockResolvedValueOnce(["5", ["analytics:org1:w1:ga4:overview:x:all"]])
      .mockResolvedValueOnce(["0", ["analytics:org1:w1:ga4:traffic:x:all"]]);
    await shared.invalidateWebsiteCache("org1", "w1");
    expect(mocks.redisScan).toHaveBeenCalledTimes(2);
    expect(mocks.redisScan).toHaveBeenCalledWith("0", "MATCH", "analytics:org1:w1:*", "COUNT", 200);
    expect(mocks.redisDel).toHaveBeenCalledWith("analytics:org1:w1:ga4:overview:x:all");
    expect(mocks.redisDel).toHaveBeenCalledWith("analytics:org1:w1:ga4:traffic:x:all");
  });
  it("org invalidation uses the org-wide pattern; empty pages skip DEL", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    mocks.redisScan.mockResolvedValueOnce(["0", []]);
    await shared.invalidateOrgCache("org1");
    expect(mocks.redisScan).toHaveBeenCalledWith("0", "MATCH", "analytics:org1:*", "COUNT", 200);
    expect(mocks.redisDel).not.toHaveBeenCalled();
  });
  it("no redis → no-op; scan error → resolves (best-effort)", async () => {
    delete process.env.REDIS_URL;
    const shared = await loadShared();
    await expect(shared.invalidateWebsiteCache("org1", "w1")).resolves.toBeUndefined();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared2 = await loadShared();
    mocks.redisScan.mockRejectedValueOnce(new Error("down"));
    await expect(shared2.invalidateOrgCache("org1")).resolves.toBeUndefined();
  });
});
