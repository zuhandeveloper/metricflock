// Configurable polling TARGETS (spec §15), not guarantees of source-data availability.
// GA4 realtime 15-30s, GA4 daily 2-5min, GA4 historical 30-60min, GSC 6-12h, AdSense/Ad Manager 1-6h.
import { SYNC_TYPE_BY_QUEUE, type QueueName, type SyncJobTypeName } from "./queue";
export const SYNC_INTERVALS = {
  ga4RealtimeSeconds: 30,
  ga4DailyMinutes: 5,
  ga4HistoricalMinutes: Number(process.env.SYNC_GA4_HISTORICAL_MINUTES ?? 45),
  searchConsoleHours: Number(process.env.SYNC_SEARCH_CONSOLE_HOURS ?? 8),
  adsenseHours: Number(process.env.SYNC_ADSENSE_HOURS ?? 3),
  adManagerHours: Number(process.env.SYNC_AD_MANAGER_HOURS ?? 3),
  healthCheckHours: Number(process.env.SYNC_HEALTH_CHECK_HOURS ?? 1),
} as const;

export type SyncProviderName = "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
export type DueSyncPlanEntry = { queue: QueueName; websiteId: string; jobId: string };

/** Interval (ms) after which a queue's sync is due again for a website. */
export function intervalMsForQueue(queue: QueueName, intervals: typeof SYNC_INTERVALS = SYNC_INTERVALS): number {
  switch (queue) {
    case "ga4-realtime-sync":
      return intervals.ga4RealtimeSeconds * 1_000;
    case "ga4-historical-sync":
      return intervals.ga4HistoricalMinutes * 60_000;
    case "search-console-sync":
      return intervals.searchConsoleHours * 3_600_000;
    case "adsense-sync":
      return intervals.adsenseHours * 3_600_000;
    case "ad-manager-sync":
      return intervals.adManagerHours * 3_600_000;
    case "integration-health-check":
      return intervals.healthCheckHours * 3_600_000;
    default:
      return Number.POSITIVE_INFINITY; // oauth-refresh / discovery / cache-refresh are event-driven, not interval-driven
  }
}

/** Queues a website's mapped providers make it eligible for. */
export function queuesForProviders(providers: SyncProviderName[], adManagerEnabled: boolean): QueueName[] {
  const queues: QueueName[] = [];
  if (providers.includes("GA4")) queues.push("ga4-realtime-sync", "ga4-historical-sync");
  if (providers.includes("SEARCH_CONSOLE")) queues.push("search-console-sync");
  if (providers.includes("ADSENSE")) queues.push("adsense-sync");
  if (providers.includes("AD_MANAGER") && adManagerEnabled) queues.push("ad-manager-sync");
  if (providers.length > 0) queues.push("integration-health-check");
  return queues;
}

/** Centralized due-check (spec §15): given every website's mapped providers and
 *  its last successful sync time per SyncJobType, decide which jobs to enqueue
 *  now. Pure function — the worker supplies DB data and performs the enqueues.
 *  JobIds are bucketed by interval window so repeat ticks dedupe in BullMQ. */
export function planDueSyncs(input: {
  websites: { id: string; providers: SyncProviderName[] }[];
  lastSucceededAt: Map<string, Date | null>; // key: `${websiteId}:${SyncJobTypeName}`
  now: Date;
  adManagerEnabled: boolean;
  intervals?: typeof SYNC_INTERVALS;
}): DueSyncPlanEntry[] {
  const intervals = input.intervals ?? SYNC_INTERVALS;
  const plan: DueSyncPlanEntry[] = [];
  for (const website of input.websites) {
    for (const queue of queuesForProviders(website.providers, input.adManagerEnabled)) {
      const intervalMs = intervalMsForQueue(queue, intervals);
      if (!Number.isFinite(intervalMs)) continue;
      const type: SyncJobTypeName = SYNC_TYPE_BY_QUEUE[queue];
      const last = input.lastSucceededAt.get(`${website.id}:${type}`) ?? null;
      const due = !last || input.now.getTime() - last.getTime() >= intervalMs;
      if (!due) continue;
      const bucket = Math.floor(input.now.getTime() / intervalMs);
      plan.push({ queue, websiteId: website.id, jobId: `${queue}:${website.id}:${bucket}` });
    }
  }
  return plan;
}
