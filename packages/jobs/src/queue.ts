import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { bullConnectionOptions } from "@metricflock/shared";
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
const queues = new Map<string, Queue>();
export function getQueue(name: QueueName): Queue | null {
  // OPS-10: BullMQ gets connection OPTIONS (dedicated connections,
  // maxRetriesPerRequest: null), never the shared cache client.
  const connection = bullConnectionOptions();
  if (!connection) return null; // No Redis: jobs are skipped, manual sync via API still works.
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection }));
  return queues.get(name)!;
}

export type EnqueueEntry = { name: QueueName; data: Record<string, unknown>; jobId: string; delayMs?: number };

function jobOptions(name: QueueName, jobId: string, delayMs?: number) {
  return {
    jobId,
    attempts: 5,
    backoff: { type: "exponential" as const, delay: 60_000 },
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
  opts: { jobId?: string; delayMs?: number } = {},
) {
  const q = getQueue(name);
  if (!q) return null;
  return q.add(
    name,
    data,
    // Default id: exactly 3 colon-separated parts (BullMQ rejects custom
    // ids with ":" in any other shape; JSON payloads contain colons).
    jobOptions(name, opts.jobId ?? `${name}:${randomUUID()}:${Date.now()}`, opts.delayMs),
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
    if (!q) continue;
    await q.addBulk(list.map((e) => ({ name, data: e.data, opts: jobOptions(name, e.jobId, e.delayMs) })));
    submitted += list.length;
  }
  return submitted;
}
