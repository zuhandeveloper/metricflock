// Configurable polling TARGETS (spec §15), not guarantees of source-data availability.
// GA4 realtime 15-30s, GA4 daily 2-5min, GA4 historical 30-60min, GSC 6-12h, AdSense/Ad Manager 1-6h.
//
// OPS-2 capacity note: the worker realtime sync only WARMS the 30s-TTL
// cache — the dashboard fetches live on cache miss, so background realtime
// does not need a 30s cadence. At 30s, 100 websites produce ~100 jobs/min
// against a 20/min queue limiter (breakeven 20 sites). The default is now
// 300s (100 sites ≈ 20/min produced, matching the limiter), with per-site
// coalescing (stable jobId) and hash stagger bounding the backlog at any
// scale. Override with SYNC_GA4_REALTIME_SECONDS if quota allows.
import { SYNC_TYPE_BY_QUEUE, type QueueName, type SyncJobTypeName } from "./queue";
export const SYNC_INTERVALS = {
  ga4RealtimeSeconds: Number(process.env.SYNC_GA4_REALTIME_SECONDS ?? 300),
  ga4DailyMinutes: 5,
  ga4HistoricalMinutes: Number(process.env.SYNC_GA4_HISTORICAL_MINUTES ?? 45),
  searchConsoleHours: Number(process.env.SYNC_SEARCH_CONSOLE_HOURS ?? 8),
  adsenseHours: Number(process.env.SYNC_ADSENSE_HOURS ?? 3),
  adManagerHours: Number(process.env.SYNC_AD_MANAGER_HOURS ?? 3),
  healthCheckHours: Number(process.env.SYNC_HEALTH_CHECK_HOURS ?? 1),
} as const;

export type SyncProviderName = "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
export type DueSyncPlanEntry = { queue: QueueName; websiteId: string; jobId: string; delayMs: number };

/** Deterministic per-website stagger (OPS-2): spreads enqueues across the
 *  scheduler tick window instead of bursting every site at once. */
export function staggerDelayMs(websiteId: string, windowMs = 60_000): number {
  let hash = 0;
  for (let i = 0; i < websiteId.length; i++) hash = (hash * 31 + websiteId.charCodeAt(i)) >>> 0;
  return hash % windowMs;
}

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
      // OPS-2 coalescing: realtime uses a STABLE per-website jobId, so at
      // most one realtime job per website can be pending — repeat enqueues
      // while one is queued/running are BullMQ no-ops. Other queues keep
      // interval-bucketed ids (dedupe within the window, fresh next window).
      const jobId =
        queue === "ga4-realtime-sync"
          ? `${queue}:${website.id}`
          : `${queue}:${website.id}:${Math.floor(input.now.getTime() / intervalMs)}`;
      plan.push({ queue, websiteId: website.id, jobId, delayMs: staggerDelayMs(website.id) });
    }
  }
  return plan;
}
