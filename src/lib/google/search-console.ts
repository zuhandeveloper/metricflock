import { google } from "googleapis";
import type { OAuth2Client } from "@/lib/google/auth-types";
// Search Console data is delayed by 2-3 days; never present it as real-time.
export const GSC_DATA_DELAY_NOTE = "Search Console data is delayed by approximately 2-3 days and is not real-time.";
export function parseGscRows(rows: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[] | undefined) {
  return (rows ?? []).map((r) => ({ keys: r.keys ?? [], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: r.ctr ?? 0, position: r.position ?? 0 }));
}
export async function querySearchAnalytics(auth: OAuth2Client, siteUrl: string, startDate: string, endDate: string, dimensions: string[] = ["date"], rowLimit = 1000) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.searchanalytics.query({ siteUrl, requestBody: { startDate, endDate, dimensions, rowLimit } });
  const rows = parseGscRows(res.data.rows as never);
  const totals = rows.reduce((acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }), { clicks: 0, impressions: 0 });
  const avgCtr = totals.impressions ? totals.clicks / totals.impressions : 0;
  const avgPosition = rows.length ? rows.reduce((s, r) => s + r.position, 0) / rows.length : 0;
  return { siteUrl, startDate, endDate, totals: { ...totals, avgCtr, avgPosition }, rows, dataDelayNote: GSC_DATA_DELAY_NOTE };
}
export async function listSitemaps(auth: OAuth2Client, siteUrl: string) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.sitemaps.list({ siteUrl });
  return (res.data.sitemap ?? []).map((s) => ({ path: s.path, lastSubmitted: s.lastSubmitted, lastDownloaded: s.lastDownloaded, errors: s.errors, warnings: s.warnings, contents: s.contents }));
}
export async function inspectUrl(auth: OAuth2Client, siteUrl: string, inspectionUrl: string) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.urlInspection.index.inspect({ requestBody: { siteUrl, inspectionUrl } });
  return res.data.inspectionResult ?? null;
}
