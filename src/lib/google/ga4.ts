import { BetaAnalyticsDataClient } from "@google-analytics/data";
import type { OAuth2Client } from "@/lib/google/auth-types";
import { toGoogleAuth } from "@/lib/google/auth-types";
// Typed parsers for GA4 Data API responses. No mocked data: every function calls the real client.
export function getGa4Client(auth: OAuth2Client) {
  // The GA4 gax client accepts a GoogleAuth instance; wrap the user's
  // OAuth2 client so per-user credentials are used (never a service account).
  return new BetaAnalyticsDataClient({ auth: toGoogleAuth(auth) });
}
export type RowLike = {
  dimensionValues?: { value?: string | null }[] | null;
  metricValues?: { value?: string | null }[] | null;
};
export function parseRealtimeRows(rows: RowLike[] | null | undefined, dimCount: number) {
  return (rows ?? []).map((r) => ({
    dimensions: (r.dimensionValues ?? []).slice(0, dimCount).map((d) => d.value ?? ""),
    activeUsers: Number(r.metricValues?.[0]?.value ?? 0),
  }));
}
export function parseReportRows(rows: RowLike[] | null | undefined, metrics: string[]) {
  return (rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    (r.dimensionValues ?? []).forEach((d, i) => { out[`dimension${i}`] = d.value ?? ""; });
    metrics.forEach((m, i) => { out[m] = Number(r.metricValues?.[i]?.value ?? 0); });
    return out;
  });
}
export async function runRealtimeReport(client: BetaAnalyticsDataClient, propertyId: string) {
  const [res] = await client.runRealtimeReport({
    property: `properties/${propertyId}`,
    dimensions: [{ name: "country" }, { name: "city" }, { name: "deviceCategory" }, { name: "browser" }, { name: "operatingSystem" }, { name: "unifiedPagePathScreen" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "activeUsers" }, { name: "eventCount" }],
  });
  const rows = (res.rows ?? []) as RowLike[];
  const total = rows.reduce((s, r) => s + Number(r.metricValues?.[0]?.value ?? 0), 0);
  const by = (dimIdx: number) => { const m = new Map<string, number>(); for (const r of rows) { const k = r.dimensionValues?.[dimIdx]?.value ?? "(not set)"; m.set(k, (m.get(k) ?? 0) + Number(r.metricValues?.[0]?.value ?? 0)); } return [...m.entries()].map(([name, activeUsers]) => ({ name, activeUsers })).sort((a, b) => b.activeUsers - a.activeUsers).slice(0, 10); };
  return {
    propertyId, activeUsers: total,
    byCountry: by(0), byCity: by(1), byDevice: by(2), byBrowser: by(3), byOperatingSystem: by(4),
    byPage: by(5), bySource: by(6),
    eventCount: rows.reduce((s, r) => s + Number(r.metricValues?.[1]?.value ?? 0), 0),
    rowCount: res.rowCount ? Number(res.rowCount) : rows.length,
    // GA4 realtime is a sampled near-real-time window, not an exact live-session census.
    reportingWindow: "Last 30 minutes (GA4 realtime, approximate)",
  };
}
export const GA4_CORE_METRICS = ["totalUsers", "activeUsers", "newUsers", "sessions", "screenPageViews", "engagedSessions", "engagementRate", "averageEngagementTime", "bounceRate", "eventCount", "keyEvents", "sessionConversionRate"];
export async function runHistoricalReport(client: BetaAnalyticsDataClient, propertyId: string, startDate: string, endDate: string, dimensions: { name: string }[] = [{ name: "date" }], metrics: string[] = GA4_CORE_METRICS) {
  const [res] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions, metrics: metrics.map((name) => ({ name })),
  });
  const totals = (res.totals ?? [])[0];
  const summary: Record<string, number> = {};
  metrics.forEach((m, i) => { summary[m] = Number(totals?.metricValues?.[i]?.value ?? 0); });
  return { propertyId, startDate, endDate, summary, rows: parseReportRows((res.rows ?? []) as RowLike[], metrics), rowCount: res.rowCount ? Number(res.rowCount) : 0 };
}
export async function runTrafficAcquisition(client: BetaAnalyticsDataClient, propertyId: string, startDate: string, endDate: string) {
  return runHistoricalReport(client, propertyId, startDate, endDate, [{ name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }, { name: "sessionCampaignName" }], ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents"]);
}
export async function runAudienceReport(client: BetaAnalyticsDataClient, propertyId: string, startDate: string, endDate: string) {
  const [country] = await Promise.all([
    runHistoricalReport(client, propertyId, startDate, endDate, [{ name: "country" }, { name: "city" }, { name: "language" }, { name: "deviceCategory" }, { name: "browser" }, { name: "operatingSystem" }, { name: "newVsReturning" }], ["activeUsers", "sessions", "engagedSessions"]),
  ]);
  return country;
}
export async function runPagesReport(client: BetaAnalyticsDataClient, propertyId: string, startDate: string, endDate: string) {
  // Article/author/category dimensions are custom dimensions; they only return data
  // when configured in the GA4 property. We request standard page dimensions here.
  return runHistoricalReport(client, propertyId, startDate, endDate, [{ name: "pagePath" }, { name: "landingPage" }], ["screenPageViews", "activeUsers", "engagedSessions", "averageEngagementTime"]);
}
export async function runEventsReport(client: BetaAnalyticsDataClient, propertyId: string, startDate: string, endDate: string) {
  return runHistoricalReport(client, propertyId, startDate, endDate, [{ name: "eventName" }], ["eventCount", "totalUsers", "keyEvents"]);
}
