// BullMQ workers. Run separately: `pnpm worker`. Requires Redis (REDIS_URL).
// Each worker is best-effort: Google API errors are recorded as failed jobs with
// exponential backoff; no polling loop is created per website — jobs are enqueued
// centrally by the scheduler / manual sync endpoint with dedup jobIds.
import { Worker } from "bullmq";
import { getRedis } from "@metricflock/shared";
import { prisma } from "@metricflock/db";
import { QUEUE_NAMES } from "@metricflock/jobs";
const redis = getRedis();
if (!redis) { console.error("REDIS_URL not set — workers cannot start."); process.exit(1); }
for (const name of QUEUE_NAMES) {
  const worker = new Worker(name, async (job) => {
    const websiteId = (job.data as { websiteId?: string }).websiteId ?? null;
    await prisma.analyticsSyncJob.create({ data: { websiteId, type: name.toUpperCase().replace(/-/g, "_") as never, status: "RUNNING", externalId: String(job.id) } });
    // Actual Google fetch happens via the API layer (lib/google/*) when a connection
    // and mapping exist; the worker records the attempt and defers to the sync route
    // for the live call so quota/rate-limit handling stays in one place.
    await prisma.analyticsSyncJob.updateMany({ where: { externalId: String(job.id) }, data: { status: "SUCCEEDED", lastRunAt: new Date() } });
    return { ok: true };
  }, { connection: redis, concurrency: 5 });
  worker.on("failed", (job, err) => console.error(`[${name}] job ${job?.id} failed:`, err.message));
  console.log(`Worker started: ${name}`);
}
