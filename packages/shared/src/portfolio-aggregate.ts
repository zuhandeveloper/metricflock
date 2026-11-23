// Portfolio aggregation math (Phase 7.1, moved to shared in 7.3 so
// the worker's report builder and the web portfolio loader share one
// implementation). Pure: sums per-website report payloads, recomputes
// rates from summed totals, and leaves underivable metrics null —
// never invents numbers.

const GA4_ADDITIVE = [
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagedSessions",
  "eventCount",
  "keyEvents",
] as const;

type Num = number | null | undefined;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sumOrNull = (values: Num[]): number | null => {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((s, v) => s + v, 0) : null;
};
const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

export function aggregatePayloads(
  report: string,
  payloads: unknown[],
): { totals: Record<string, number | null> | null; note: string | null } {
  if (report === "overview") {
    const summaries = payloads.map(
      (p) => ((p as { summary?: Record<string, unknown> })?.summary ?? {}) as Record<string, unknown>,
    );
    const totals: Record<string, number | null> = {};
    for (const m of GA4_ADDITIVE) totals[m] = sumOrNull(summaries.map((s) => num(s[m])));
    totals.engagementRate = ratio(totals.engagedSessions, totals.sessions);
    totals.bounceRate = totals.engagementRate === null ? null : 1 - totals.engagementRate;
    totals.sessionConversionRate = ratio(totals.keyEvents, totals.sessions);
    // Cannot be derived from per-property totals (needs raw durations).
    totals.averageEngagementTime = null;
    return {
      totals,
      note: "activeUsers/newUsers are sums across properties — a person visiting two websites counts twice. Rates are recomputed from summed totals; averageEngagementTime cannot be aggregated and is null.",
    };
  }
  if (report === "search-console") {
    const ts = payloads.map(
      (p) => ((p as { totals?: Record<string, unknown> })?.totals ?? {}) as Record<string, unknown>,
    );
    const clicks = sumOrNull(ts.map((t) => num(t.clicks)));
    const impressions = sumOrNull(ts.map((t) => num(t.impressions)));
    const weighted = ts.reduce((s, t) => {
      const pos = num(t.avgPosition);
      const imp = num(t.impressions);
      return pos === null || imp === null ? s : s + pos * imp;
    }, 0);
    return {
      totals: {
        clicks,
        impressions,
        avgCtr: ratio(clicks, impressions),
        avgPosition: impressions ? weighted / impressions : null,
      },
      note: "avgPosition is impression-weighted across properties; avgCtr is recomputed from summed clicks/impressions.",
    };
  }
  if (report === "adsense") {
    const ts = payloads.map(
      (p) => ((p as { totalsByMetric?: Record<string, unknown> })?.totalsByMetric ?? {}) as Record<string, unknown>,
    );
    const metric = (name: string) =>
      sumOrNull(
        ts.map((t) => {
          const v = t[name];
          return typeof v === "string" && v !== "" ? Number(v) : num(v);
        }),
      );
    const earnings = metric("ESTIMATED_EARNINGS");
    const pageViews = metric("PAGE_VIEWS");
    const impressions = metric("IMPRESSIONS");
    const clicks = metric("CLICKS");
    return {
      totals: {
        ESTIMATED_EARNINGS: earnings,
        PAGE_VIEWS: pageViews,
        IMPRESSIONS: impressions,
        CLICKS: clicks,
        CTR: ratio(clicks, impressions),
        CPC: ratio(earnings, clicks),
        PAGE_RPM: pageViews ? ((earnings ?? 0) / pageViews) * 1000 : null,
        IMPRESSION_RPM: impressions ? ((earnings ?? 0) / impressions) * 1000 : null,
      },
      note: "AdSense figures are estimated earnings, not finalized payments. Rates are recomputed from summed totals.",
    };
  }
  return { totals: null, note: "aggregation_not_supported_for_report" };
}
