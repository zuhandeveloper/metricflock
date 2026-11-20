// BullMQ workers with the REAL Google fetch (ADR-0005 option (a)).
// Run separately: `pnpm worker`. Requires Redis (REDIS_URL) and, for the
// Google calls, DATABASE_URL + GOOGLE_TOKEN_ENCRYPTION_KEY (+ OAuth client
// credentials for token refresh).
//
// Each processor delegates to the sync engine in @metricflock/google/sync:
// resolve connection -> call provider -> warm Redis cache -> record health.
// This file owns only queue wiring and AnalyticsSyncJob bookkeeping.
// Jobs are enqueued centrally by the scheduler (./scheduler.ts) and the
// manual sync endpoint, with dedup jobIds — no per-website polling loops.
import { Worker, type Job } from "bullmq";
import { getRedis } from "@metricflock/shared";
import { prisma } from "@metricflock/db";
import { QUEUE_NAMES, SYNC_TYPE_BY_QUEUE, intervalMsForQueue, type QueueName } from "@metricflock/jobs";
import {
  syncWebsite,
  refreshConnection,
  discoverConnectionProperties,
  SyncRateLimitError,
  type SyncResult,
} from "@metricflock/google/sync";
import { resolveConnectionForWebsite } from "@metricflock/google/client";
import { startScheduler } from "./scheduler";

type SyncJobData = { websiteId?: string; connectionId?: string };

const redis = getRedis();
if (!redis) {
  console.error("REDIS_URL not set — workers cannot start.");
  process.exit(1);
}

async function connectionIdForJob(data: SyncJobData): Promise<string | null> {
  if (data.connectionId) return data.connectionId;
  if (!data.websiteId) return null;
  const resolved = await resolveConnectionForWebsite(data.websiteId);
  return resolved.status === "connected" ? resolved.connectionId : null;
}

async function runJob(name: QueueName, data: SyncJobData): Promise<SyncResult> {
  const websiteId = data.websiteId ?? null;
  switch (name) {
    case "ga4-realtime-sync":
      return syncWebsite(websiteId!, "ga4-realtime");
    case "ga4-historical-sync":
      return syncWebsite(websiteId!, "ga4-historical");
    case "search-console-sync":
      return syncWebsite(websiteId!, "search-console");
    case "adsense-sync":
      return syncWebsite(websiteId!, "adsense");
    case "ad-manager-sync":
      return syncWebsite(websiteId!, "ad-manager");
    case "analytics-cache-refresh":
      return syncWebsite(websiteId!, "cache-refresh");
    case "integration-health-check":
      return syncWebsite(websiteId!, "health-check");
    case "google-oauth-refresh": {
      const connectionId = await connectionIdForJob(data);
      if (!connectionId) return { status: "not_connected", reports: [], detail: "No connection to refresh." };
      return refreshConnection(connectionId);
    }
    case "google-property-discovery": {
      const connectionId = await connectionIdForJob(data);
      if (!connectionId)
        return { status: "not_connected", reports: [], detail: "No connection to discover properties for." };
      const counts = await discoverConnectionProperties(connectionId);
      return {
        status: "ok",
        reports: [],
        detail: `discovered ga4=${counts.ga4} searchConsole=${counts.searchConsole} adsense=${counts.adsense} adManager=${counts.adManager}`,
      };
    }
  }
}

const LIMITERS: Partial<Record<QueueName, { max: number; duration: number }>> = {
  "ga4-realtime-sync": { max: 20, duration: 60_000 },
  "ga4-historical-sync": { max: 20, duration: 60_000 },
  "search-console-sync": { max: 10, duration: 60_000 },
  "adsense-sync": { max: 10, duration: 60_000 },
  "ad-manager-sync": { max: 10, duration: 60_000 },
  "google-oauth-refresh": { max: 10, duration: 60_000 },
  "google-property-discovery": { max: 10, duration: 60_000 },
  "integration-health-check": { max: 20, duration: 60_000 },
  "analytics-cache-refresh": { max: 10, duration: 60_000 },
};

for (const name of QUEUE_NAMES) {
  const worker = new Worker(
    name,
    async (job: Job<SyncJobData>) => {
      const websiteId = job.data.websiteId ?? null;
      const type = SYNC_TYPE_BY_QUEUE[name];
      const row = await prisma.analyticsSyncJob.create({
        data: { websiteId, type, status: "RUNNING", externalId: String(job.id), attempts: job.attemptsMade + 1 },
      });
      try {
        const result = await runJob(name, job.data);
        const intervalMs = intervalMsForQueue(name);
        await prisma.analyticsSyncJob.update({
          where: { id: row.id },
          data: {
            status: "SUCCEEDED",
            lastRunAt: new Date(),
            lastError: result.status === "ok" ? null : `${result.status}${result.detail ? `: ${result.detail}` : ""}`,
            nextRunAt: Number.isFinite(intervalMs) ? new Date(Date.now() + intervalMs) : null,
          },
        });
        return result;
      } catch (err) {
        if (err instanceof SyncRateLimitError) {
          await prisma.analyticsSyncJob.update({
            where: { id: row.id },
            data: { status: "RETRYING", lastError: "rate limited (per-connection); job delayed" },
          });
          throw Worker.RateLimitError();
        }
        const msg = err instanceof Error ? err.message : String(err);
        const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade - 1;
        await prisma.analyticsSyncJob.update({
          where: { id: row.id },
          data: {
            status: attemptsLeft > 0 ? "RETRYING" : "FAILED",
            lastError: msg.slice(0, 500),
            lastRunAt: new Date(),
          },
        });
        throw err; // BullMQ retries with exponential backoff (queue.ts)
      }
    },
    { connection: redis, concurrency: 5, limiter: LIMITERS[name] },
  );
  worker.on("failed", (job, err) => console.error(`[${name}] job ${job?.id} failed:`, err.message));
  console.log(`Worker started: ${name}`);
}

startScheduler(redis);
