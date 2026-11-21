import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
// Search Console data is delayed by 2-3 days; never present it as real-time.
export const GSC_DATA_DELAY_NOTE = "Search Console data is delayed by approximately 2-3 days and is not real-time.";
export function parseGscRows(
  rows: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[] | undefined,
) {
  return (rows ?? []).map((r) => ({
    keys: r.keys ?? [],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export type GscTotals = {
  clicks: number;
  impressions: number;
  avgCtr: number;
  /** Impression-weighted average position; null when there are no
   *  impressions to weight by (DATA-2). */
  avgPosition: number | null;
};

/** Totals computed from detail rows (fallback when the provider totals
 *  query returns nothing). Position is impression-weighted, never a
 *  simple mean of per-row positions (DATA-2). */
export function computeGscTotals(rows: ReturnType<typeof parseGscRows>): GscTotals {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  return {
    clicks,
    impressions,
    avgCtr: impressions ? clicks / impressions : 0,
    avgPosition: impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : null,
  };
}

const GSC_MAX_PAGES = 5;

export async function querySearchAnalytics(
  auth: OAuth2Client,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ["date"],
  rowLimit = 1000,
) {
  const sc = google.searchconsole({ version: "v1", auth });
  // DATA-3: totals come from a separate dimension-less query. Reducing the
  // detail page (sorted by clicks, capped at rowLimit) undercounts every
  // site with more rows than the page size.
  const totalsRes = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { startDate, endDate, dimensions: [], rowLimit: 1 },
  });
  const totalsRow = parseGscRows(totalsRes.data.rows as never)[0];
  // Detail rows are paginated with startRow; `truncated` surfaces when the
  // page cap is hit instead of silently dropping the tail.
  const rows: ReturnType<typeof parseGscRows> = [];
  let truncated = false;
  for (let page = 0; page < GSC_MAX_PAGES; page++) {
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: { startDate, endDate, dimensions, rowLimit, startRow: page * rowLimit },
    });
    const pageRows = parseGscRows(res.data.rows as never);
    rows.push(...pageRows);
    if (pageRows.length < rowLimit) break;
    if (page === GSC_MAX_PAGES - 1) truncated = true;
  }
  const totals: GscTotals = totalsRow
    ? {
        clicks: totalsRow.clicks,
        impressions: totalsRow.impressions,
        avgCtr: totalsRow.ctr,
        avgPosition: totalsRow.impressions ? totalsRow.position : null,
      }
    : computeGscTotals(rows);
  return {
    siteUrl,
    startDate,
    endDate,
    totals,
    rows,
    truncated,
    dataDelayNote: GSC_DATA_DELAY_NOTE,
  };
}
export async function listSitemaps(auth: OAuth2Client, siteUrl: string) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.sitemaps.list({ siteUrl });
  return (res.data.sitemap ?? []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted,
    lastDownloaded: s.lastDownloaded,
    errors: s.errors,
    warnings: s.warnings,
    contents: s.contents,
  }));
}
export async function inspectUrl(auth: OAuth2Client, siteUrl: string, inspectionUrl: string) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.urlInspection.index.inspect({ requestBody: { siteUrl, inspectionUrl } });
  return res.data.inspectionResult ?? null;
}
