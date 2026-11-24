import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { dirname } from "node:path";

// Coverage-gap closure: packages/jobs/src/queue.ts — getQueue, enqueue,
// enqueueBulk, the queue/type maps and jobOptions (via the opts passed
// to Queue.add). BullMQ is a dependency of the jobs workspace package,
// so a plain vi.mock("bullmq") misses (see the vitest alias note for
// googleapis/ioredis); the mock is registered with vi.doMock against
// bullmq's resolved entry file instead.
const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  addBulk: vi.fn(),
  constructed: [] as { name: string; opts: unknown }[],
}));

class FakeQueue {
  name: string;
  constructor(name: string, opts: unknown) {
    this.name = name;
    mocks.constructed.push({ name, opts });
  }
  add = mocks.add;
  addBulk = mocks.addBulk;
}

const require = createRequire(import.meta.url);
// Resolve bullmq through the jobs package itself (no relative path into
// another package): @metricflock/jobs resolves to packages/jobs/src,
// whose node_modules hold the bullmq copy queue.ts imports.
const jobsSrcDir = dirname(require.resolve("@metricflock/jobs"));
const bullmqEntry = require.resolve("bullmq", { paths: [jobsSrcDir] });

type Jobs = typeof import("@metricflock/jobs");

async function loadJobs(): Promise<Jobs> {
  vi.resetModules();
  return import("@metricflock/jobs");
}

const savedRedisUrl = process.env.REDIS_URL;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.constructed.length = 0;
  mocks.add.mockResolvedValue({ id: "job-1" });
  mocks.addBulk.mockResolvedValue(undefined);
  vi.doMock(bullmqEntry, () => ({ Queue: FakeQueue }));
});

afterEach(() => {
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
  vi.resetModules();
});

describe("queue/type maps", () => {
  it("SYNC_TYPE_BY_QUEUE covers all 10 queues; QUEUE_BY_SYNC_TYPE reverses it", async () => {
    const jobs = await loadJobs();
    expect(jobs.QUEUE_NAMES).toHaveLength(10);
    for (const name of jobs.QUEUE_NAMES) {
      const type = jobs.SYNC_TYPE_BY_QUEUE[name];
      expect(typeof type).toBe("string");
      expect(jobs.QUEUE_BY_SYNC_TYPE[type]).toBe(name);
    }
    expect(jobs.SYNC_TYPE_BY_QUEUE["ga4-historical-sync"]).toBe("GA4_HISTORICAL");
    expect(jobs.SYNC_TYPE_BY_QUEUE["ga4-realtime-sync"]).toBe("GA4_REALTIME");
    expect(jobs.SYNC_TYPE_BY_QUEUE["scheduled-report"]).toBe("SCHEDULED_REPORT");
  });
  it("SYNC_TYPE_BY_REPORT maps dashboard reports to sync types", async () => {
    const jobs = await loadJobs();
    expect(jobs.SYNC_TYPE_BY_REPORT).toMatchObject({
      overview: "GA4_HISTORICAL",
      realtime: "GA4_REALTIME",
      "search-console": "SEARCH_CONSOLE",
      adsense: "ADSENSE",
      "ad-manager": "AD_MANAGER",
    });
  });
});

describe("getQueue", () => {
  it("no REDIS_URL → null (jobs skipped, manual sync via API still works)", async () => {
    delete process.env.REDIS_URL;
    const jobs = await loadJobs();
    expect(jobs.getQueue("ga4-historical-sync")).toBeNull();
    expect(mocks.constructed).toHaveLength(0);
  });
  it("with REDIS_URL → one cached Queue per name, BullMQ-owned connection options", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const jobs = await loadJobs();
    const first = jobs.getQueue("ga4-historical-sync");
    const second = jobs.getQueue("ga4-historical-sync");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    jobs.getQueue("adsense-sync");
    expect(mocks.constructed).toHaveLength(2);
    expect(mocks.constructed[0]).toEqual({
      name: "ga4-historical-sync",
      opts: {
        connection: { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null },
      },
    });
  });
});

describe("enqueue", () => {
  it("no queue → null without touching BullMQ", async () => {
    delete process.env.REDIS_URL;
    const jobs = await loadJobs();
    expect(await jobs.enqueue("ga4-historical-sync", { websiteId: "w1" })).toBeNull();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("enqueues with attempts/backoff/priority/removeOnFail and a 3-part default jobId", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const jobs = await loadJobs();
    const job = await jobs.enqueue("ga4-historical-sync", { websiteId: "w1" }, { priority: 1 });
    expect(job).toEqual({ id: "job-1" });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    const [, , opts] = mocks.add.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({
      attempts: 5,
      backoff: { type: "custom" },
      priority: 1,
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    expect(String(opts.jobId).split(":")).toHaveLength(3);
    expect(String(opts.jobId).startsWith("ga4-historical-sync:")).toBe(true);
  });
  it("custom jobId + delay are passed through; realtime completes remove immediately", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const jobs = await loadJobs();
    await jobs.enqueue("ga4-realtime-sync", { websiteId: "w1" }, { jobId: "a:b:c", delayMs: 5000 });
    const [, , opts] = mocks.add.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({ jobId: "a:b:c", delay: 5000, removeOnComplete: true, priority: 10 });
  });
});

describe("enqueueBulk", () => {
  it("groups by queue, one addBulk per queue, returns the submitted count", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const jobs = await loadJobs();
    const n = await jobs.enqueueBulk([
      { name: "ga4-historical-sync", data: { websiteId: "w1" }, jobId: "a:b:1" },
      { name: "ga4-historical-sync", data: { websiteId: "w2" }, jobId: "a:b:2" },
      { name: "adsense-sync", data: { websiteId: "w1" }, jobId: "a:b:3", priority: 1 },
    ]);
    expect(n).toBe(3);
    expect(mocks.addBulk).toHaveBeenCalledTimes(2);
    const firstCall = mocks.addBulk.mock.calls[0][0] as { name: string; data: unknown; opts: unknown }[];
    expect(firstCall).toHaveLength(2);
    expect(firstCall[0]).toMatchObject({ name: "ga4-historical-sync", data: { websiteId: "w1" } });
    expect((firstCall[0].opts as { jobId: string }).jobId).toBe("a:b:1");
    const secondCall = mocks.addBulk.mock.calls[1][0] as { name: string; opts: { priority: number } }[];
    expect(secondCall).toHaveLength(1);
    expect(secondCall[0].opts.priority).toBe(1);
  });
  it("no queue → 0 submitted, addBulk never called", async () => {
    delete process.env.REDIS_URL;
    const jobs = await loadJobs();
    const n = await jobs.enqueueBulk([{ name: "ga4-historical-sync", data: {}, jobId: "a:b:1" }]);
    expect(n).toBe(0);
    expect(mocks.addBulk).not.toHaveBeenCalled();
  });
  it("empty entries → 0 without touching any queue", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    const jobs = await loadJobs();
    expect(await jobs.enqueueBulk([])).toBe(0);
    expect(mocks.constructed).toHaveLength(0);
  });
});
