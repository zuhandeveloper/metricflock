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
import { createServer } from "node:http";
import { Worker, type Job } from "bullmq";
import { getRedis, bullConnectionOptions } from "@metricflock/shared";
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

type SyncJobData = { websiteId?: string; connectionId?: string; syncJobRowId?: string };

const redis = getRedis();
const bullConnection = bullConnectionOptions();
if (!redis || !bullConnection) {
  console.error("REDIS_URL not set — workers cannot start.");
  process.exit(1);
}
const redisClient: NonNullable<typeof redis> = redis;

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

const workers: Worker[] = [];
for (const name of QUEUE_NAMES) {
  const worker = new Worker(
    name,
    async (job: Job<SyncJobData>) => {
      const websiteId = job.data.websiteId ?? null;
      const type = SYNC_TYPE_BY_QUEUE[name];
      // OPS-3: ONE bookkeeping row per BullMQ job, upserted by externalId
      // across attempts (was: a new row per attempt). Manual sync passes
      // its pre-created row id so that row is the one updated (no orphans).
      // OPS-4: the payload is stored so failed jobs stay inspectable.
      const externalId = String(job.id);
      const row = job.data.syncJobRowId
        ? await prisma.analyticsSyncJob.update({
            where: { id: job.data.syncJobRowId },
            data: { status: "RUNNING", externalId, attempts: job.attemptsMade + 1, payload: { ...job.data } },
          })
        : await prisma.analyticsSyncJob.upsert({
            where: { externalId },
            update: { status: "RUNNING", attempts: job.attemptsMade + 1, payload: { ...job.data } },
            create: {
              websiteId,
              type,
              status: "RUNNING",
              externalId,
              attempts: job.attemptsMade + 1,
              payload: { ...job.data },
            },
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
    // OPS-10: BullMQ owns dedicated connections (options, not the shared
    // cache client) with maxRetriesPerRequest: null.
    { connection: bullConnection, concurrency: 5, limiter: LIMITERS[name] },
  );
  worker.on("failed", (job, err) => console.error(`[${name}] job ${job?.id} failed:`, err.message));
  workers.push(worker);
  console.log(`Worker started: ${name}`);
}

const scheduler = startScheduler(redisClient);

// OPS-9: liveness/readiness endpoint for the host/Docker HEALTHCHECK.
// /healthz = process up; /readyz = Redis + DB reachable.
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 8080);
const healthServer = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url === "/readyz") {
    try {
      await redisClient.ping();
      await prisma.$queryRaw`SELECT 1`;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ready" }));
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "not_ready" }));
    }
    return;
  }
  res.writeHead(404).end();
});
healthServer.listen(healthPort, () => console.log(`Health endpoint on :${healthPort} (/healthz, /readyz)`));

// OPS-5: graceful shutdown — stop taking jobs, let in-flight work finish,
// close connections, then exit. Without this, SIGTERM mid-job means
// stalled redelivery and duplicate side effects.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — shutting down gracefully…`);
  scheduler.stop();
  healthServer.close();
  await Promise.allSettled(workers.map((w) => w.close()));
  await prisma.$disconnect().catch(() => {});
  redisClient.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
