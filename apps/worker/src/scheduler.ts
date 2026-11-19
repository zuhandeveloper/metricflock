// Centralized sync scheduler (spec §15). One tick per minute (guarded by a
// Redis lock so multiple worker instances never double-enqueue) decides which
// websites are due for which sync, using SYNC_INTERVALS and each website's
// last successful sync. Jobs carry bucketed dedup jobIds, so repeat ticks
// inside the same interval window are no-ops in BullMQ.
//
// Also enqueues: OAuth refresh for connections whose access token expires
// within 10 minutes, and property discovery for connections with no
// discovered properties yet.
import { prisma } from "@metricflock/db";
import { getRedis } from "@metricflock/shared";
import { enqueue, planDueSyncs, type SyncProviderName } from "@metricflock/jobs";
import { adManagerEnabled } from "@metricflock/google/ad-manager";

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

const TICK_MS = 60_000;
const LOCK_KEY = "metricflock:scheduler:lock";
const LOCK_TTL_MS = 55_000;

async function tick(redis: RedisClient): Promise<void> {
  const token = `${process.pid}:${Date.now()}`;
  const acquired = await redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
  if (acquired !== "OK") return; // another instance is scheduling this tick
  const now = new Date();

  const websites = await prisma.website.findMany({
    where: { integrations: { some: { mappingStatus: "MAPPED" } } },
    select: { id: true, integrations: { where: { mappingStatus: "MAPPED" }, select: { provider: true } } },
  });
  const lastRows = await prisma.analyticsSyncJob.groupBy({
    by: ["websiteId", "type"],
    where: { status: "SUCCEEDED", websiteId: { not: null } },
    _max: { updatedAt: true },
  });
  const lastSucceededAt = new Map<string, Date | null>();
  for (const row of lastRows) {
    if (row.websiteId) lastSucceededAt.set(`${row.websiteId}:${row.type}`, row._max.updatedAt);
  }
  const plan = planDueSyncs({
    websites: websites.map((w) => ({ id: w.id, providers: [...new Set(w.integrations.map((i) => i.provider as SyncProviderName))] })),
    lastSucceededAt,
    now,
    adManagerEnabled: adManagerEnabled(),
  });
  for (const entry of plan) {
    await enqueue(entry.queue, { websiteId: entry.websiteId }, { jobId: entry.jobId });
  }

  const expiring = await prisma.googleConnection.findMany({
    where: { status: "ACTIVE", tokenExpiresAt: { not: null, lt: new Date(now.getTime() + 10 * 60_000) } },
    select: { id: true },
  });
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  for (const conn of expiring) {
    await enqueue("google-oauth-refresh", { connectionId: conn.id }, { jobId: `google-oauth-refresh:${conn.id}:${hourBucket}` });
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
    await enqueue("google-property-discovery", { connectionId: conn.id }, { jobId: `google-property-discovery:${conn.id}:${dayBucket}` });
  }

  if (plan.length || expiring.length || undiscovered.length) {
    console.log(`[scheduler] enqueued syncs=${plan.length} oauth-refresh=${expiring.length} discovery=${undiscovered.length}`);
  }
}

export function startScheduler(redis: RedisClient): void {
  const run = () => { tick(redis).catch((err) => console.error("[scheduler] tick failed:", err instanceof Error ? err.message : String(err))); };
  run();
  setInterval(run, TICK_MS);
  console.log("Scheduler started (60s tick)");
}
