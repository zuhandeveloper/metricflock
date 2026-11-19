import { Queue } from "bullmq";
import { getRedis } from "./cache";
export const QUEUE_NAMES = ["google-oauth-refresh", "google-property-discovery", "ga4-realtime-sync", "ga4-historical-sync", "search-console-sync", "adsense-sync", "ad-manager-sync", "analytics-cache-refresh", "integration-health-check"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
const queues = new Map<string, Queue>();
export function getQueue(name: QueueName): Queue | null {
  const redis = getRedis();
  if (!redis) return null; // No Redis: jobs are skipped, manual sync via API still works.
  if (!queues.has(name)) queues.set(name, new Queue(name, { connection: redis }));
  return queues.get(name)!;
}
export async function enqueue(name: QueueName, data: Record<string, unknown>, opts: { jobId?: string; delayMs?: number } = {}) {
  const q = getQueue(name);
  if (!q) return null;
  return q.add(name, data, {
    jobId: opts.jobId ?? `${name}:${JSON.stringify(data)}:${Date.now()}`,
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100, removeOnFail: 100,
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
  });
}
