// SEO / revenue intelligence (Phase 7.4). Pure derivations from the
// per-website snapshot payloads the sync engine already writes:
//  - Search Console rows are dimensioned [date, query, page] — query
//    and page aggregates are summed here, positions impression-
//    weighted, CTR recomputed (never averaged from row CTRs).
//  - AdSense rows are dimensioned [DATE] with estimated earnings.
//  - GA4 traffic rows are dimensioned [channel, sourceMedium,
//    campaign] with sessions.
// Nothing is invented: missing payloads yield empty insights, and a
// truncated Search Console row set is flagged as such.

type ScRow = { keys?: string[]; clicks?: number; impressions?: number; position?: number };
type ScPayload = {
  totals?: { clicks?: number; impressions?: number; avgCtr?: number; avgPosition?: number | null };
  rows?: ScRow[];
  truncated?: boolean;
};

export type QueryStat = { query: string; clicks: number; impressions: number; ctr: number; position: number | null };
export type PageStat = { page: string; clicks: number; impressions: number; ctr: number; position: number | null };

export type SeoInsights = {
  queryCount: number;
  pageCount: number;
  truncated: boolean;
  strikingDistance: QueryStat[]; // position 4-20, impressions >= 10
  lowCtr: QueryStat[]; // impressions >= 50, CTR below the site average
  topQueries: QueryStat[];
  topPages: PageStat[];
};

function aggregateBy(
  rows: ScRow[],
  keyIndex: number,
): Map<string, { clicks: number; impressions: number; weightedPos: number }> {
  const map = new Map<string, { clicks: number; impressions: number; weightedPos: number }>();
  for (const r of rows) {
    const key = r.keys?.[keyIndex];
    if (!key) continue;
    const cur = map.get(key) ?? { clicks: 0, impressions: 0, weightedPos: 0 };
    cur.clicks += r.clicks ?? 0;
    cur.impressions += r.impressions ?? 0;
    cur.weightedPos += (r.position ?? 0) * (r.impressions ?? 0);
    map.set(key, cur);
  }
  return map;
}

const toStat = (name: string, v: { clicks: number; impressions: number; weightedPos: number }) => ({
  name,
  clicks: v.clicks,
  impressions: v.impressions,
  ctr: v.impressions ? v.clicks / v.impressions : 0,
  position: v.impressions ? v.weightedPos / v.impressions : null,
});

export function seoInsights(payload: unknown): SeoInsights {
  const p = (payload ?? {}) as ScPayload;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const queries = [...aggregateBy(rows, 1)].map(([q, v]) => {
    const s = toStat(q, v);
    return { query: s.name, clicks: s.clicks, impressions: s.impressions, ctr: s.ctr, position: s.position };
  });
  const pages = [...aggregateBy(rows, 2)].map(([pg, v]) => {
    const s = toStat(pg, v);
    return { page: s.name, clicks: s.clicks, impressions: s.impressions, ctr: s.ctr, position: s.position };
  });
  const avgCtr = p.totals?.avgCtr ?? 0;
  const byImpressions = (a: QueryStat, b: QueryStat) => b.impressions - a.impressions;
  return {
    queryCount: queries.length,
    pageCount: pages.length,
    truncated: p.truncated === true,
    strikingDistance: queries
      .filter((q) => q.position !== null && q.position >= 4 && q.position <= 20 && q.impressions >= 10)
      .sort(byImpressions)
      .slice(0, 10),
    lowCtr: queries
      .filter((q) => q.impressions >= 50 && avgCtr > 0 && q.ctr < avgCtr)
      .sort(byImpressions)
      .slice(0, 10),
    topQueries: [...queries].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
    topPages: pages.sort((a, b) => b.clicks - a.clicks).slice(0, 10),
  };
}

type AdSenseRow = Record<string, string | number>;
type AdSensePayload = { rows?: AdSenseRow[]; totalsByMetric?: Record<string, string | number> };

export type RevenueInsights = {
  totalEarnings: number | null;
  daysWithData: number;
  avgDailyEarnings: number | null;
  bestDay: { date: string; earnings: number } | null;
  trendPercent: number | null; // second-half avg vs first-half avg
};

export function revenueInsights(payload: unknown): RevenueInsights {
  const p = (payload ?? {}) as AdSensePayload;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const daily = rows
    .map((r) => ({
      date: String(r.DATE ?? ""),
      earnings: typeof r.ESTIMATED_EARNINGS === "number" ? r.ESTIMATED_EARNINGS : Number(r.ESTIMATED_EARNINGS ?? 0),
    }))
    .filter((d) => d.date !== "")
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalRaw = p.totalsByMetric?.ESTIMATED_EARNINGS;
  const totalEarnings = totalRaw === undefined || totalRaw === "" ? null : Number(totalRaw);
  if (daily.length === 0) {
    return { totalEarnings, daysWithData: 0, avgDailyEarnings: null, bestDay: null, trendPercent: null };
  }
  const sum = daily.reduce((s, d) => s + d.earnings, 0);
  const bestDay = daily.reduce((best, d) => (d.earnings > best.earnings ? d : best), daily[0]!);
  const half = Math.floor(daily.length / 2);
  let trendPercent: number | null = null;
  if (half >= 1 && daily.length - half >= 1) {
    const firstAvg = daily.slice(0, half).reduce((s, d) => s + d.earnings, 0) / half;
    const secondAvg = daily.slice(half).reduce((s, d) => s + d.earnings, 0) / (daily.length - half);
    trendPercent = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : null;
  }
  return {
    totalEarnings,
    daysWithData: daily.length,
    avgDailyEarnings: sum / daily.length,
    bestDay,
    trendPercent,
  };
}

type TrafficRow = Record<string, string | number>;
type TrafficPayload = { rows?: TrafficRow[] };

export type ChannelShare = { channel: string; sessions: number; sharePercent: number };

export function channelMix(payload: unknown): ChannelShare[] {
  const p = (payload ?? {}) as TrafficPayload;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const byChannel = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const channel = String(r.dimension0 ?? "").trim() || "(not set)";
    const sessions = typeof r.sessions === "number" ? r.sessions : Number(r.sessions ?? 0);
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + sessions);
    total += sessions;
  }
  return [...byChannel]
    .map(([channel, sessions]) => ({ channel, sessions, sharePercent: total ? (sessions / total) * 100 : 0 }))
    .sort((a, b) => b.sessions - a.sessions);
}
