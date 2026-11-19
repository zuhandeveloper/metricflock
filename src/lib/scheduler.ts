// Configurable polling TARGETS (spec §15), not guarantees of source-data availability.
// GA4 realtime 15-30s, GA4 daily 2-5min, GA4 historical 30-60min, GSC 6-12h, AdSense/Ad Manager 1-6h.
export const SYNC_INTERVALS = {
  ga4RealtimeSeconds: 30,
  ga4DailyMinutes: 5,
  ga4HistoricalMinutes: Number(process.env.SYNC_GA4_HISTORICAL_MINUTES ?? 45),
  searchConsoleHours: Number(process.env.SYNC_SEARCH_CONSOLE_HOURS ?? 8),
  adsenseHours: Number(process.env.SYNC_ADSENSE_HOURS ?? 3),
  adManagerHours: Number(process.env.SYNC_AD_MANAGER_HOURS ?? 3),
} as const;
