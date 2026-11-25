import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { bullConnectionOptions, createLogger, incr } from "@metricflock/shared";
export const QUEUE_NAMES = [
  "google-oauth-refresh",
  "google-property-discovery",
  "ga4-realtime-sync",
  "ga4-historical-sync",
  "search-console-sync",
  "adsense-sync",
  "ad-manager-sync",
  "analytics-cache-refresh",
  "integration-health-check",
  "scheduled-report",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
/** Queue name -> Prisma SyncJobType enum value. Explicit map: a naive
 *  uppercase/underscore transform produces values that are NOT in the enum
 *  (e.g. GA4_HISTORICAL_SYNC vs GA4_HISTORICAL) and Prisma rejects them. */
export const SYNC_TYPE_BY_QUEUE = {
  "google-oauth-refresh": "OAUTH_REFRESH",
  "google-property-discovery": "PROPERTY_DISCOVERY",
  "ga4-realtime-sync": "GA4_REALTIME",
  "ga4-historical-sync": "GA4_HISTORICAL",
  "search-console-sync": "SEARCH_CONSOLE",
  "adsense-sync": "ADSENSE",
  "ad-manager-sync": "AD_MANAGER",
  "analytics-cache-refresh": "CACHE_REFRESH",
  "integration-health-check": "HEALTH_CHECK",
  "scheduled-report": "SCHEDULED_REPORT",
} as const satisfies Record<QueueName, string>;
export type SyncJobTypeName = (typeof SYNC_TYPE_BY_QUEUE)[QueueName];
/** Reverse map for the DLQ requeue path (Stage 8): a failed
 *  AnalyticsSyncJob row knows its SyncJobType; requeue needs its queue. */
export const QUEUE_BY_SYNC_TYPE: Record<string, QueueName> = Object.fromEntries(
  Object.entries(SYNC_TYPE_BY_QUEUE).map(([queue, type]) => [type, queue as QueueName]),
);
/** Analytics report name (web routes) -> SyncJobType, for last-successful-sync lookups. */
export const SYNC_TYPE_BY_REPORT: Record<string, SyncJobTypeName> = {
  realtime: "GA4_REALTIME",
  overview: "GA4_HISTORICAL",
  traffic: "GA4_HISTORICAL",
  audience: "GA4_HISTORICAL",
  pages: "GA4_HISTORICAL",
  events: "GA4_HISTORICAL",
  "search-console": "SEARCH_CONSOLE",
  adsense: "ADSENSE",
  "ad-manager": "AD_MANAGER",
};
const log = createLogger("jobs");
const queues = new Map<string, Queue>();

/** Job priorities (Phase 5, F-5.5): BullMQ processes lower numbers
 * first. User-triggered work outranks scheduled background sync so a
 * "Sync now" click is never stuck behind a 10k-site schedule sweep. */
export const JOB_PRIORITY = {
  MANUAL: 1,
  REQUEUE: 2,
  REALTIME: 5,
  SCHEDULED: 10,
} as const;

/** Exponential backoff with jitter (Phase 5, F-5.5): 60s base doubling
 * per retry, capped at 1h, scaled by a random 0.5–1.0 factor so retries
 * from many jobs failing together (e.g. a Google outage) spread out
 * instead of stampeding at the same instant. `attemptsMade` is a
 * 0-based retry index (0 = first retry → 30–60 s); BullMQ passes its
 * strategy argument 1-based (attemptsMade + 1), so the worker
 * registration subtracts 1 (A-WRK-13). With attempts: 5 the longest
 * base is 480 s — the 1h cap is a guard for a future attempts increase,
 * unreachable today. `rand` is injectable for tests. Registered as the
 * workers' custom BullMQ backoffStrategy. */
export function jitteredBackoffMs(attemptsMade: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attemptsMade), 3_600_000);
  return Math.round(base * (0.5 + rand() * 0.5));
}
export function getQueue(name: QueueName): Queue | null {
  // OPS-10: BullMQ gets connection OPTIONS (dedicated connections,
  // maxRetriesPerRequest: null), never the shared cache client.
  const connection = bullConnectionOptions();
  if (!connection) return null; // No Redis: jobs are skipped, manual sync via API still works.
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection }));
  return queues.get(name)!;
}

export type EnqueueEntry = {
  name: QueueName;
  data: Record<string, unknown>;
  jobId: string;
  delayMs?: number;
  priority?: number;
};

function jobOptions(name: QueueName, jobId: string, delayMs?: number, priority?: number) {
  return {
    jobId,
    attempts: 5,
    // Custom strategy (jitteredBackoffMs) registered on every Worker —
    // plain "exponential" has no jitter and retries would synchronize.
    backoff: { type: "custom" as const },
    priority: priority ?? JOB_PRIORITY.SCHEDULED,
    // Realtime jobs are coalesced by stable jobId (OPS-2): the completed
    // job must be removed immediately or BullMQ would dedupe the NEXT
    // cycle's enqueue against the finished one. Other queues keep a
    // bounded completed/failed history in Redis; the durable record is
    // the AnalyticsSyncJob row (OPS-4).
    removeOnComplete: name === "ga4-realtime-sync" ? true : 100,
    removeOnFail: 500,
    ...(delayMs ? { delay: delayMs } : {}),
  };
}

export async function enqueue(
  name: QueueName,
  data: Record<string, unknown>,
  opts: { jobId?: string; delayMs?: number; priority?: number } = {},
) {
  const q = getQueue(name);
  if (!q) return null;
  return q.add(
    name,
    data,
    // Default id: exactly 3 colon-separated parts (BullMQ rejects custom
    // ids with ":" in any other shape; JSON payloads contain colons).
    jobOptions(name, opts.jobId ?? `${name}:${randomUUID()}:${Date.now()}`, opts.delayMs, opts.priority),
  );
}

/** Bulk enqueue (OPS-7/11): one Redis round trip per queue instead of a
 *  sequential await per job. Returns the number of jobs submitted. */
export async function enqueueBulk(entries: EnqueueEntry[]): Promise<number> {
  const byQueue = new Map<QueueName, EnqueueEntry[]>();
  for (const e of entries) {
    const list = byQueue.get(e.name) ?? [];
    list.push(e);
    byQueue.set(e.name, list);
  }
  let submitted = 0;
  for (const [name, list] of byQueue) {
    const q = getQueue(name);
    if (!q) {
      // A-WRK-17: a missing Redis connection used to drop these jobs
      // silently — the scheduler tick then enqueued nothing with no
      // signal anywhere (the manual-sync path returns 503 instead).
      // Record the skip: one error log per skipped queue (not per job)
      // and a counter on /metrics counting the dropped jobs, so a
      // mid-run Redis outage is visible instead of silent.
      incr("scheduler.enqueue_skipped_no_redis", list.length);
      log.error("enqueueBulk skipped jobs: no Redis connection", { queue: name, skipped: list.length });
      continue;
    }
    await q.addBulk(list.map((e) => ({ name, data: e.data, opts: jobOptions(name, e.jobId, e.delayMs, e.priority) })));
    submitted += list.length;
  }
  return submitted;
}
