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
  rateLimit,
  isEncryptionKey,
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
import { sendOrgReport } from "./report";

type SyncJobData = { websiteId?: string; connectionId?: string; syncJobRowId?: string; organizationId?: string };

const log = createLogger("worker");

// A-WRK-11: a stray rejection/exception (e.g. a floating Prisma/Redis
// promise in a processor path) must not kill the process silently — log
// it and exit non-zero so the host restarts cleanly. The handlers are
// exported so tests can invoke them directly.
export function handleUncaughtException(err: unknown): void {
  log.error("uncaught exception — crashing", errMeta(err));
  process.exit(1);
}
export function handleUnhandledRejection(reason: unknown): void {
  log.error("unhandled rejection — crashing", errMeta(reason));
  process.exit(1);
}
process.on("uncaughtException", handleUncaughtException);
process.on("unhandledRejection", handleUnhandledRejection);

// A-SEC-14 follow-up: the web boot gate (getEnv() in
// packages/shared/src/env.ts) does not cover the worker — it never calls
// getEnv(), and it must not: SESSION_SECRET is required by that schema but
// deliberately NOT set on the worker (deploy pack), so a full getEnv() here
// would crash-loop a healthy worker. Without this check a missing or
// invalid GOOGLE_TOKEN_ENCRYPTION_KEY only surfaces at the first token
// decrypt, after jobs are already flowing. Fail at boot instead, like the
// web app. Exported so tests can invoke it directly with synthetic envs.
export function assertBootEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (!isEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY)) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes in production");
  }
  if (env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS && !isEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS)) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS must be base64 of 32 bytes in production");
  }
}
try {
  assertBootEnv();
} catch (err) {
  log.error("worker environment invalid — exiting", errMeta(err));
  process.exit(1);
}

// A-WRK-16: failure alerts are capped per organization so a provider
// outage cannot email every SUPER_ADMIN once per (website, queue) —
// 100 failing websites used to mean 100+ sequential emails inside job
// handlers. At most one failure alert (per admin) leaves per org per
// window; further failure alerts in the window are counted
// (alerts.suppressed on /metrics) and logged instead of emailed. The
// first failure in a window still alerts immediately, so an isolated
// failure is never delayed or silenced. The gate is the shared
// Redis-backed rate limiter, so the cap is fleet-wide; if Redis is
// unreachable it degrades to the limiter's per-process fallback (the
// cap multiplies per instance, but alerts never go fully silent) —
// deliberately NOT failClosed, unlike the sensitive-endpoint policy:
// alerting must not go dark because Redis hiccuped. Recovery emails
// are not gated (bounded by the health-transition dedup, and they are
// the all-clear signal).
export const ALERT_WINDOW_MS = 15 * 60_000;

async function claimAlertSlot(organizationId: string): Promise<boolean> {
  const { allowed } = await rateLimit(`alert:${organizationId}`, 1, ALERT_WINDOW_MS);
  incr(allowed ? "alerts.sent" : "alerts.suppressed");
  return allowed;
}

async function alertSyncFailure(websiteId: string, queue: string, error: string): Promise<void> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { name: true, domain: true, organizationId: true },
  });
  if (!website) return;
  if (!(await claimAlertSlot(website.organizationId))) {
    log.warn("sync failure alert suppressed by per-org alert cap", {
      websiteId,
      queue,
      organizationId: website.organizationId,
    });
    return;
  }
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
  // A-WRK-16: failure alerts share the per-org budget with terminal
  // sync failures; recoveries always send.
  if (kind === "alert_error" && !(await claimAlertSlot(website.organizationId))) {
    log.warn("health failure alert suppressed by per-org alert cap", {
      websiteId,
      provider,
      organizationId: website.organizationId,
    });
    return;
  }
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
  // A-WRK-20: the sync queues need a websiteId — a payload without one
  // is skipped explicitly (mirroring the scheduled-report guard below)
  // instead of asserting non-null and syncing against null, which only
  // happened to degrade to no_mapping downstream.
  const noWebsiteId: SyncResult = { status: "skipped", reports: [], detail: "sync job without websiteId" };
  switch (name) {
    case "ga4-realtime-sync":
      return websiteId ? syncWebsite(websiteId, "ga4-realtime", workerDeps) : noWebsiteId;
    case "ga4-historical-sync":
      return websiteId ? syncWebsite(websiteId, "ga4-historical", workerDeps) : noWebsiteId;
    case "search-console-sync":
      return websiteId ? syncWebsite(websiteId, "search-console", workerDeps) : noWebsiteId;
    case "adsense-sync":
      return websiteId ? syncWebsite(websiteId, "adsense", workerDeps) : noWebsiteId;
    case "ad-manager-sync":
      return websiteId ? syncWebsite(websiteId, "ad-manager", workerDeps) : noWebsiteId;
    case "analytics-cache-refresh":
      return websiteId ? syncWebsite(websiteId, "cache-refresh", workerDeps) : noWebsiteId;
    case "integration-health-check":
      return websiteId ? syncWebsite(websiteId, "health-check", workerDeps) : noWebsiteId;
    case "scheduled-report":
      if (!data.organizationId) return { status: "skipped", reports: [], detail: "report job without organizationId" };
      return sendOrgReport(data.organizationId);
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
      // A-GGL-13: per-provider failures are collected in `errors` instead
      // of aborting the discovery — surface them in the detail string so
      // the job row shows them (the job itself still SUCCEEDED: a disabled
      // API cannot be fixed by retrying). `pruned` likewise, when present.
      const errorDetail = counts.errors
        ? `; errors: ${Object.entries(counts.errors)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        : "";
      const prunedDetail = counts.pruned
        ? `; pruned: ${Object.entries(counts.pruned)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        : "";
      return {
        status: "ok",
        reports: [],
        detail: `discovered ga4=${counts.ga4} searchConsole=${counts.searchConsole} adsense=${counts.adsense} adManager=${counts.adManager}${errorDetail}${prunedDetail}`,
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
          // A-WRK-14: BullMQ treats RateLimitError specially — the job
          // goes back to wait under the queue limiter WITHOUT consuming
          // an attempt, WITHOUT the custom backoff, and WITHOUT emitting
          // "failed" (so jobs.failed.* never fires). The row stays
          // RETRYING (the sync route treats it as in-progress), but the
          // note must name the actual state — waiting, not a backoff
          // retry — and the branch counts + logs the event itself so a
          // quota storm is visible on /metrics instead of invisible.
          await prisma.analyticsSyncJob.update({
            where: { id: row.id },
            data: {
              status: "RETRYING",
              lastError: "rate limited (per-connection quota); job waiting under queue limiter (no attempt consumed)",
            },
          });
          incr(`jobs.ratelimited.${name}`);
          log.warn("job rate limited — waiting under queue limiter", {
            queue: name,
            jobId: job.id,
            websiteId,
            error: err.message,
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
    // A-WRK-13: BullMQ invokes the strategy with attemptsMade + 1
    // (job.js Backoffs.calculate), i.e. 1 on the first failure, while
    // jitteredBackoffMs takes a 0-based retry index — subtract 1 so the
    // effective first retry is the documented 30–60 s (60 s base ×
    // jitter), not 60–120 s.
    {
      connection: bullConnection,
      concurrency: 5,
      limiter: LIMITERS[name],
      settings: { backoffStrategy: (attemptsMade: number) => jitteredBackoffMs(attemptsMade - 1) },
    },
  );
  worker.on("completed", () => incr(`jobs.succeeded.${name}`));
  worker.on("failed", (job, err) => {
    incr(`jobs.failed.${name}`);
    log.error("job failed", { queue: name, jobId: job?.id, error: err.message });
  });
  // A-WRK-20: a stalled job (lock lost mid-run — e.g. a Redis blip during
  // lock renewal) is re-run by BullMQ after maxStalledCount, so without
  // these listeners a duplicate execution leaves no trace. Count + log
  // both events; the handlers run on the worker's event loop and must
  // never throw. Lock settings are untouched (the 30 s default with
  // auto-renewal is verified fine while the process is alive).
  worker.on("stalled", (jobId, prev) => {
    incr(`jobs.stalled.${name}`);
    log.warn("job stalled — lock lost, job will be re-run", { queue: name, jobId, prev });
  });
  worker.on("lockRenewalFailed", (jobIds) => {
    incr(`jobs.lock_renewal_failed.${name}`, jobIds.length);
    log.warn("job lock renewal failed", { queue: name, jobIds });
  });
  workers.push(worker);
  log.info("worker started", { queue: name });
}

const scheduler = startScheduler(redisClient);

// OPS-9: liveness/readiness endpoint for the host/Docker HEALTHCHECK.
// /healthz = process up; /readyz = Redis + DB reachable.
// A-WRK-19: /healthz, /readyz and /metrics are unauthenticated — the
// Docker HEALTHCHECK and the host's readiness probe need /readyz
// without credentials, and /metrics exposes only low-sensitivity
// in-process counters — so the health port must NOT be publicly
// exposed: keep it on the host's private network / internal-only. It
// is deliberately not bound to 127.0.0.1: the Docker HEALTHCHECK runs
// inside the container (loopback would work there), but Railway's
// healthcheck probes the service port from outside the container, and
// a loopback-only bind would refuse it.
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
// A-WRK-19: a listen failure (e.g. EADDRINUSE — the health port is
// already taken) must be a clean, logged exit, not an unhandled
// `error` event crashing the process after all workers have started.
// Exported so tests can invoke it directly (same pattern as the
// uncaught-exception handlers above).
export function handleHealthServerError(err: unknown): void {
  log.error("health server failed — exiting", { port: healthPort, ...errMeta(err) });
  process.exit(1);
}
healthServer.on("error", handleHealthServerError);
healthServer.listen(healthPort, () => log.info("health endpoint listening", { port: healthPort }));

// A-WRK-11: bound the drain. Docker `stop` gives 10 s by default and
// Railway's RAILWAY_DEPLOYMENT_DRAINING_SECONDS defaults to 0 — the
// finding's suggested 25 s would be SIGKILLed before it ever fired on
// either default, so the default is 8 s (2 s headroom for the
// force-close + final disconnects). Raise WORKER_SHUTDOWN_TIMEOUT_MS
// only together with the host's grace period (Railway: set
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS in the service settings, otherwise
// the host SIGKILLs immediately and no in-process timeout can help).
export const SHUTDOWN_TIMEOUT_MS = (() => {
  const ms = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 8_000);
  return Number.isFinite(ms) && ms > 0 ? ms : 8_000;
})();

// OPS-5: graceful shutdown — stop taking jobs, let in-flight work finish,
// close connections, then exit. Without this, SIGTERM mid-job means
// stalled redelivery and duplicate side effects.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down gracefully", { signal });
  // A-WRK-11: stop scheduling first and await any in-flight tick, so it
  // cannot keep enqueueing while the workers close.
  await scheduler.stop();
  // Await the health-server close so the host stops routing readiness
  // probes at a draining process.
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  // Bound the worker drain: Worker.close() waits for in-flight jobs,
  // and a slow Google call could hold it past the orchestrator's kill
  // grace period. After SHUTDOWN_TIMEOUT_MS, force-close instead of
  // being SIGKILLed mid-job.
  const closeWorkers = Promise.allSettled(workers.map((w) => w.close()));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closeWorkers.then(() => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (timedOut) {
    log.warn("shutdown timed out — force-closing workers", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    await Promise.allSettled(workers.map((w) => w.close(true)));
  }
  await prisma.$disconnect().catch(() => {});
  // ioredis disconnect() is synchronous (it closes the socket
  // immediately); it runs before exit so no Redis connection is left
  // dangling.
  redisClient.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
