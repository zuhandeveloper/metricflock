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
import {
  getRedis,
  bullConnectionOptions,
  createLogger,
  errMeta,
  incr,
  counterSnapshot,
  sanitizeProviderError,
  healthTransition,
} from "@metricflock/shared";
import { prisma } from "@metricflock/db";
import { recordHealth } from "@metricflock/db/health";
import {
  QUEUE_NAMES,
  SYNC_TYPE_BY_QUEUE,
  intervalMsForQueue,
  jitteredBackoffMs,
  type QueueName,
} from "@metricflock/jobs";
import {
  syncWebsite,
  refreshConnection,
  discoverConnectionProperties,
  defaultSyncDeps,
  SyncRateLimitError,
  type SyncResult,
  type SyncDeps,
} from "@metricflock/google/sync";
import { resolveConnectionForWebsite } from "@metricflock/google/client";
import { sendMail } from "@metricflock/auth/mailer";
import { startScheduler } from "./scheduler";

type SyncJobData = { websiteId?: string; connectionId?: string; syncJobRowId?: string };

const log = createLogger("worker");

async function alertSyncFailure(websiteId: string, queue: string, error: string): Promise<void> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { name: true, domain: true, organizationId: true },
  });
  if (!website) return;
  const admins = await prisma.user.findMany({
    where: { organizationId: website.organizationId, role: "SUPER_ADMIN" },
    select: { email: true },
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  for (const admin of admins) {
    await sendMail({
      to: admin.email,
      subject: `MetricFlock: sync failed for ${website.domain}`,
      text: [
        `The ${queue} sync for ${website.name} (${website.domain}) failed after all retries.`,
        ``,
        `Error: ${sanitizeProviderError(error, 300)}`,
        ``,
        appUrl ? `Open the dashboard: ${appUrl}/websites/${websiteId}` : `Open the dashboard to investigate.`,
        `If the Google connection was revoked, reconnect it from Integrations.`,
      ].join("\n"),
    });
  }
}

async function alertHealthTransition(
  websiteId: string,
  provider: string,
  kind: "alert_error" | "recovered",
  error?: string | null,
): Promise<void> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { name: true, domain: true, organizationId: true },
  });
  if (!website) return;
  const admins = await prisma.user.findMany({
    where: { organizationId: website.organizationId, role: "SUPER_ADMIN" },
    select: { email: true },
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const failed = kind === "alert_error";
  for (const admin of admins) {
    await sendMail({
      to: admin.email,
      subject: failed
        ? `MetricFlock: ${provider} integration failing for ${website.domain}`
        : `MetricFlock: ${provider} integration recovered for ${website.domain}`,
      text: [
        failed
          ? `The ${provider} integration for ${website.name} (${website.domain}) started failing health checks.`
          : `The ${provider} integration for ${website.name} (${website.domain}) is healthy again.`,
        ``,
        ...(failed && error ? [`Error: ${sanitizeProviderError(error, 300)}`, ``] : []),
        appUrl ? `Open integration health: ${appUrl}/health` : `Open the Health page in the dashboard to investigate.`,
        ...(failed ? [`If the Google connection was revoked, reconnect it from Integrations.`] : []),
      ].join("\n"),
    });
  }
}

// Phase 7.2: health writes go through this wrapper so a provider
// flipping into error (or recovering) emails org SUPER_ADMINs exactly
// once per transition — repeated failing checks stay silent.
const alertingRecordHealth: SyncDeps["recordHealth"] = async (opts) => {
  const prev =
    opts.websiteId != null
      ? await prisma.integrationHealth
          .findUnique({
            where: { websiteId_provider: { websiteId: opts.websiteId, provider: opts.provider } },
            select: { status: true },
          })
          .catch(() => null)
      : null;
  const result = await recordHealth(opts);
  const transition = healthTransition(prev?.status ?? null, opts.status);
  if (transition && opts.websiteId) {
    await alertHealthTransition(opts.websiteId, opts.provider, transition, opts.lastError).catch((e) =>
      log.error("health alert email failed", errMeta(e)),
    );
  }
  return result;
};

const workerDeps: SyncDeps = { ...defaultSyncDeps, recordHealth: alertingRecordHealth };

const redis = getRedis();
const bullConnection = bullConnectionOptions();
if (!redis || !bullConnection) {
  log.error("REDIS_URL not set — workers cannot start");
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
      return syncWebsite(websiteId!, "ga4-realtime", workerDeps);
    case "ga4-historical-sync":
      return syncWebsite(websiteId!, "ga4-historical", workerDeps);
    case "search-console-sync":
      return syncWebsite(websiteId!, "search-console", workerDeps);
    case "adsense-sync":
      return syncWebsite(websiteId!, "adsense", workerDeps);
    case "ad-manager-sync":
      return syncWebsite(websiteId!, "ad-manager", workerDeps);
    case "analytics-cache-refresh":
      return syncWebsite(websiteId!, "cache-refresh", workerDeps);
    case "integration-health-check":
      return syncWebsite(websiteId!, "health-check", workerDeps);
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
            lastError:
              result.status === "ok"
                ? null
                : sanitizeProviderError(`${result.status}${result.detail ? `: ${result.detail}` : ""}`),
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
            lastError: sanitizeProviderError(err),
            lastRunAt: new Date(),
          },
        });
        // Stage 7 alert: a terminally failed sync emails the org's
        // SUPER_ADMINs (best-effort — alerting must never mask the job
        // error or crash the worker).
        if (attemptsLeft <= 0 && websiteId) {
          incr(`jobs.terminal_failed.${name}`);
          await alertSyncFailure(websiteId, name, msg).catch((e) =>
            log.error("sync failure alert email failed", { queue: name, websiteId, ...errMeta(e) }),
          );
        }
        throw err; // BullMQ retries with jittered exponential backoff (queue.ts)
      }
    },
    // OPS-10: BullMQ owns dedicated connections (options, not the shared
    // cache client) with maxRetriesPerRequest: null.
    // Phase 5 (F-5.5): custom backoff strategy = exponential + jitter.
    {
      connection: bullConnection,
      concurrency: 5,
      limiter: LIMITERS[name],
      settings: { backoffStrategy: (attemptsMade: number) => jitteredBackoffMs(attemptsMade) },
    },
  );
  worker.on("completed", () => incr(`jobs.succeeded.${name}`));
  worker.on("failed", (job, err) => {
    incr(`jobs.failed.${name}`);
    log.error("job failed", { queue: name, jobId: job?.id, error: err.message });
  });
  workers.push(worker);
  log.info("worker started", { queue: name });
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
  if (req.url === "/metrics") {
    // Stage 8: in-process job/cache counters + uptime for the host's
    // monitoring. The durable picture lives in AnalyticsSyncJob rows
    // (see the web app's /api/metrics).
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        ts: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        counters: counterSnapshot(),
      }),
    );
    return;
  }
  res.writeHead(404).end();
});
healthServer.listen(healthPort, () => log.info("health endpoint listening", { port: healthPort }));

// OPS-5: graceful shutdown — stop taking jobs, let in-flight work finish,
// close connections, then exit. Without this, SIGTERM mid-job means
// stalled redelivery and duplicate side effects.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down gracefully", { signal });
  scheduler.stop();
  healthServer.close();
  await Promise.allSettled(workers.map((w) => w.close()));
  await prisma.$disconnect().catch(() => {});
  redisClient.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
