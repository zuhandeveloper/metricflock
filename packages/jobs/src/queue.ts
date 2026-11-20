import { Queue } from "bullmq";
import { getRedis } from "@metricflock/shared";
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
  const redis = getRedis();
  if (!redis) return null; // No Redis: jobs are skipped, manual sync via API still works.
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: redis }));
  return queues.get(name)!;
}
export async function enqueue(
  name: QueueName,
  data: Record<string, unknown>,
  opts: { jobId?: string; delayMs?: number } = {},
) {
  const q = getQueue(name);
  if (!q) return null;
  return q.add(name, data, {
    jobId: opts.jobId ?? `${name}:${JSON.stringify(data)}:${Date.now()}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
  });
}
