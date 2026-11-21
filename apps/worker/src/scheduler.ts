// Centralized sync scheduler (spec §15). One tick per minute (guarded by a
// Redis lock so multiple worker instances never double-enqueue) decides which
// websites are due for which sync, using SYNC_INTERVALS and each website's
// last successful sync. Jobs carry bucketed dedup jobIds, so repeat ticks
// inside the same interval window are no-ops in BullMQ.
//
// Also enqueues: OAuth refresh for connections whose access token expires
// within 10 minutes, and property discovery for connections with no
// discovered properties yet.
import { randomUUID } from "node:crypto";
import { prisma } from "@metricflock/db";
import { getRedis } from "@metricflock/shared";
import { enqueueBulk, getQueue, planDueSyncs, type EnqueueEntry, type SyncProviderName } from "@metricflock/jobs";
import { adManagerEnabled } from "@metricflock/google/ad-manager";

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

const TICK_MS = 60_000;
const LOCK_KEY = "metricflock:scheduler:lock";
const LOCK_TTL_MS = 55_000;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
// OPS-2 backpressure: skip realtime enqueues while the queue already holds
// more than this many waiting+delayed jobs (2 minutes of limiter capacity).
const REALTIME_BACKPRESSURE_DEPTH = 40;
// OPS-3 retention: bookkeeping rows older than this are pruned per tick.
const RETENTION_DAYS = 30;
const WEBSITE_PAGE_SIZE = 500;

let tickRunning = false;

async function tick(redis: RedisClient): Promise<void> {
  if (tickRunning) return; // OPS-7: never overlap ticks in-process
  tickRunning = true;
  const token = randomUUID(); // OPS-7: unique per tick (pid is 1 in every container)
  try {
    const acquired = await redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
    if (acquired !== "OK") return; // another instance is scheduling this tick
    try {
      await runTick();
    } finally {
      // OPS-7: release only our own lock (compare-and-delete).
      await redis.eval(RELEASE_LUA, 1, LOCK_KEY, token).catch(() => {});
    }
  } finally {
    tickRunning = false;
  }
}

async function runTick(): Promise<void> {
  const now = new Date();

  // OPS-11: paginate websites instead of loading every mapped site at once.
  const websites: { id: string; providers: SyncProviderName[] }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.website.findMany({
      where: { integrations: { some: { mappingStatus: "MAPPED" } } },
      select: { id: true, integrations: { where: { mappingStatus: "MAPPED" }, select: { provider: true } } },
      orderBy: { id: "asc" },
      take: WEBSITE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const w of page) {
      websites.push({ id: w.id, providers: [...new Set(w.integrations.map((i) => i.provider as SyncProviderName))] });
    }
    if (page.length < WEBSITE_PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
  // OPS-11: window the last-success lookup (30d covers every interval;
  // older successes are equivalent to "never" for due purposes).
  const windowStart = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const lastRows = await prisma.analyticsSyncJob.groupBy({
    by: ["websiteId", "type"],
    where: { status: "SUCCEEDED", websiteId: { not: null }, updatedAt: { gte: windowStart } },
    _max: { updatedAt: true },
  });
  const lastSucceededAt = new Map<string, Date | null>();
  for (const row of lastRows) {
    if (row.websiteId) lastSucceededAt.set(`${row.websiteId}:${row.type}`, row._max.updatedAt);
  }
  let plan = planDueSyncs({ websites, lastSucceededAt, now, adManagerEnabled: adManagerEnabled() });

  // OPS-2 backpressure: if realtime is already backed up, skip this tick's
  // realtime enqueues (coalescing means the pending jobs still cover every
  // site; the dashboard fetches live on cache miss regardless).
  const realtimeQueue = getQueue("ga4-realtime-sync");
  if (realtimeQueue && plan.some((p) => p.queue === "ga4-realtime-sync")) {
    const counts = await realtimeQueue.getJobCounts("waiting", "delayed").catch(() => null);
    const depth = counts ? (counts.waiting ?? 0) + (counts.delayed ?? 0) : 0;
    if (depth > REALTIME_BACKPRESSURE_DEPTH) {
      console.log(`[scheduler] realtime backpressure: depth=${depth}, skipping realtime enqueues this tick`);
      plan = plan.filter((p) => p.queue !== "ga4-realtime-sync");
    }
  }

  const entries: EnqueueEntry[] = plan.map((p) => ({
    name: p.queue,
    data: { websiteId: p.websiteId },
    jobId: p.jobId,
    delayMs: p.delayMs,
  }));

  const expiring = await prisma.googleConnection.findMany({
    where: { status: "ACTIVE", tokenExpiresAt: { not: null, lt: new Date(now.getTime() + 10 * 60_000) } },
    select: { id: true },
  });
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  for (const conn of expiring) {
    entries.push({
      name: "google-oauth-refresh",
      data: { connectionId: conn.id },
      jobId: `google-oauth-refresh:${conn.id}:${hourBucket}`,
    });
  }

  const undiscovered = await prisma.googleConnection.findMany({
    where: {
      status: "ACTIVE",
      properties: { none: {} },
      searchConsoleProps: { none: {} },
      adsenseAccounts: { none: {} },
      adManagerNetworks: { none: {} },
    },
    select: { id: true },
  });
  const dayBucket = Math.floor(now.getTime() / 86_400_000);
  for (const conn of undiscovered) {
    entries.push({
      name: "google-property-discovery",
      data: { connectionId: conn.id },
      jobId: `google-property-discovery:${conn.id}:${dayBucket}`,
    });
  }

  // OPS-7/11: one bulk round trip per queue instead of sequential awaits.
  const submitted = await enqueueBulk(entries);
  if (submitted) {
    console.log(
      `[scheduler] enqueued=${submitted} (syncs=${plan.length} oauth-refresh=${expiring.length} discovery=${undiscovered.length})`,
    );
  }

  // OPS-3 retention: prune old bookkeeping in bounded batches.
  const pruned = await prisma.analyticsSyncJob.deleteMany({
    where: { updatedAt: { lt: windowStart }, status: { in: ["SUCCEEDED", "FAILED"] } },
  });
  if (pruned.count) console.log(`[scheduler] pruned ${pruned.count} old sync-job rows`);
}

export function startScheduler(redis: RedisClient): { stop: () => void } {
  const run = () => {
    tick(redis).catch((err) =>
      console.error("[scheduler] tick failed:", err instanceof Error ? err.message : String(err)),
    );
  };
  run();
  const timer = setInterval(run, TICK_MS);
  console.log("Scheduler started (60s tick)");
  return { stop: () => clearInterval(timer) };
}
