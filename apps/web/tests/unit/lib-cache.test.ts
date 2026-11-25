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
  // Store-backed mode (fakeredis-style): when true, get/set/scan/del run
  // against this in-memory Map instead of the vi.fn stubs, so a test can
  // exercise a real cacheSet → cacheGet round-trip and a real SCAN+DEL
  // invalidation (only the target scope's keys disappear). The scan
  // snapshots the matching keys on cursor "0" and serves bounded pages
  // from it (scanPageSize), like a real SCAN cursor loop.
  storeMode: false,
  store: new Map<string, string>(),
  scanSnapshot: [] as string[],
  scanPageSize: 2,
  listeners: [] as Array<{ event: string; handler: (...args: unknown[]) => void }>,
}));

/** Minimal glob → RegExp for `*` patterns (used by the store-backed scan
 *  and by the pattern-scoping assertions). */
function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}

class FakeRedis {
  url: string;
  opts: unknown;
  constructor(url: string, opts: unknown) {
    if (mocks.ctorShouldThrow) throw new Error("ctor boom");
    this.url = url;
    this.opts = opts;
    mocks.instances.push(this);
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    mocks.listeners.push({ event, handler });
    return this;
  }
  async get(key: string) {
    if (mocks.storeMode) return mocks.store.get(key) ?? null;
    return mocks.redisGet(key);
  }
  async set(key: string, value: string, ...args: unknown[]) {
    if (mocks.storeMode) {
      mocks.store.set(key, value);
      return "OK";
    }
    return mocks.redisSet(key, value, ...args);
  }
  async scan(cursor: string, ...args: unknown[]) {
    if (mocks.storeMode) {
      if (cursor === "0") {
        const re = globToRegExp(String(args[1]));
        mocks.scanSnapshot = [...mocks.store.keys()].filter((k) => re.test(k)).sort();
      }
      const start = Number(cursor) || 0;
      const page = mocks.scanSnapshot.slice(start, start + mocks.scanPageSize);
      const next = start + mocks.scanPageSize >= mocks.scanSnapshot.length ? "0" : String(start + mocks.scanPageSize);
      return [next, page] as [string, string[]];
    }
    return mocks.redisScan(cursor, ...args);
  }
  async del(...args: unknown[]) {
    if (mocks.storeMode) {
      let n = 0;
      for (const k of args as string[]) if (mocks.store.delete(k)) n++;
      return n;
    }
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
  mocks.storeMode = false;
  mocks.store.clear();
  mocks.scanSnapshot.length = 0;
  mocks.listeners.length = 0;
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

// A-COV-07: the mocked-stub tests above prove the call shapes, but a stub
// can never catch an envelope mismatch between cacheSet and cacheGet (the
// writer and the reader are stubbed independently). These store-backed
// tests run the real functions against a real in-memory store — a true
// set/get round-trip — and prove the mock really intercepts the module
// the code loads: if vi.mock("ioredis") missed, cacheSet would hit a
// real client and the round-trip below would fail.
describe("cacheSet/cacheGet round-trip (in-memory store)", () => {
  beforeEach(() => {
    mocks.storeMode = true;
  });
  it("set then get returns the same value, fresh (stale:false), envelope expiry ~ttl", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    await shared.cacheSet("fresh-key", { rows: [1, 2] }, 300);
    expect(await shared.cacheGet("fresh-key")).toEqual({ value: { rows: [1, 2] }, stale: false });
    const envelope = JSON.parse(mocks.store.get("fresh-key")!) as { value: unknown; expiresAt: number };
    expect(envelope.value).toEqual({ rows: [1, 2] });
    expect(envelope.expiresAt).toBeGreaterThan(Date.now());
    expect(envelope.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });
  it("envelope written with a past expiry reads back stale:true", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    mocks.store.set("stale-key", JSON.stringify({ value: { rows: [9] }, expiresAt: Date.now() - 1000 }));
    expect(await shared.cacheGet("stale-key")).toEqual({ value: { rows: [9] }, stale: true });
  });
  it("missing key → null; empty-string raw → null (miss, not a parse error)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    expect(await shared.cacheGet("absent")).toBeNull();
    mocks.store.set("empty", "");
    expect(await shared.cacheGet("empty")).toBeNull();
  });
});

describe("invalidation against a real store (fakeredis-style)", () => {
  beforeEach(() => {
    mocks.storeMode = true;
    for (const k of [
      "analytics:org1:w1:ga4:overview:28d:all",
      "analytics:org1:w1:ga4:traffic:28d:all",
      "analytics:org1:w1:search-console:overview:28d:all",
      "analytics:org1:w1:adsense:overview:28d:all",
      "analytics:org1:w1:ga4:audience:28d:all",
      "analytics:org1:w2:ga4:overview:28d:all",
      "analytics:org2:w1:ga4:overview:28d:all",
    ]) {
      mocks.store.set(k, JSON.stringify({ value: 1, expiresAt: Date.now() + 60_000 }));
    }
  });
  it("invalidateWebsiteCache deletes only that website's keys (paged scan: 5 keys, page size 2)", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    await shared.invalidateWebsiteCache("org1", "w1");
    expect([...mocks.store.keys()].sort()).toEqual([
      "analytics:org1:w2:ga4:overview:28d:all",
      "analytics:org2:w1:ga4:overview:28d:all",
    ]);
  });
  it("invalidateOrgCache deletes the whole org and nothing else", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    await shared.invalidateOrgCache("org1");
    expect([...mocks.store.keys()]).toEqual(["analytics:org2:w1:ga4:overview:28d:all"]);
  });
});

describe("invalidation key patterns — exact prefixes, scoped", () => {
  it("website pattern matches only that website; org pattern only that org", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    mocks.redisScan.mockResolvedValue(["0", []]);
    await shared.invalidateWebsiteCache("org1", "w1");
    const websitePattern = mocks.redisScan.mock.calls[0][2] as string;
    expect(websitePattern).toBe("analytics:org1:w1:*");
    const websiteRe = globToRegExp(websitePattern);
    expect(websiteRe.test("analytics:org1:w1:ga4:overview:28d:all")).toBe(true);
    // A sibling website in the same org and the same website in another
    // org must NOT match: a too-wide pattern would wipe other sites' cache.
    expect(websiteRe.test("analytics:org1:w2:ga4:overview:28d:all")).toBe(false);
    expect(websiteRe.test("analytics:org2:w1:ga4:overview:28d:all")).toBe(false);
    await shared.invalidateOrgCache("org1");
    const orgPattern = mocks.redisScan.mock.calls[1][2] as string;
    expect(orgPattern).toBe("analytics:org1:*");
    const orgRe = globToRegExp(orgPattern);
    expect(orgRe.test("analytics:org1:w2:ga4:overview:28d:all")).toBe(true);
    expect(orgRe.test("analytics:org2:w1:ga4:overview:28d:all")).toBe(false);
  });
  it("invalidateOrgCache with no redis → no-op (the !r branch)", async () => {
    delete process.env.REDIS_URL;
    const shared = await loadShared();
    await expect(shared.invalidateOrgCache("org1")).resolves.toBeUndefined();
    expect(mocks.redisScan).not.toHaveBeenCalled();
  });
});

describe("getRedis error listener + bullConnectionOptions encoding", () => {
  it("registers an error listener on the client; invoking it never throws", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const shared = await loadShared();
    expect(shared.getRedis()).not.toBeNull();
    const errorListeners = mocks.listeners.filter((l) => l.event === "error");
    expect(errorListeners).toHaveLength(1);
    expect(() => errorListeners[0].handler(new Error("boom"))).not.toThrow();
  });
  it("bullConnectionOptions decodes a URL-encoded password", async () => {
    const shared = await loadShared();
    process.env.REDIS_URL = "redis://user:p%40ss%3Aw%2Frd@redis.example:6379";
    expect(shared.bullConnectionOptions()).toEqual({
      host: "redis.example",
      port: 6379,
      password: "p@ss:w/rd",
      username: "user",
      maxRetriesPerRequest: null,
    });
  });
});
