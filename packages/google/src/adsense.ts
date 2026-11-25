import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
import { parseStrictDate } from "@metricflock/shared";
import { GOOGLE_API_TIMEOUT_MS, withGoogleTimeout } from "./timeout";
// AdSense figures are ESTIMATED earnings, not finalized payments.
export const ADSENSE_ESTIMATED_NOTE = "AdSense figures are estimated earnings, not finalized payments.";

// AdSense Management API v2 Metric enum
// (https://developers.google.com/adsense/management/reference/rest/v2/Metric):
// there is no CTR, CPC, PAGE_RPM or IMPRESSION_RPM — the valid names are
// PAGE_VIEWS_CTR / AD_REQUESTS_CTR / IMPRESSIONS_CTR, COST_PER_CLICK,
// PAGE_VIEWS_RPM / AD_REQUESTS_RPM / IMPRESSIONS_RPM. Live 2026-11-24 the
// worker's AdSense jobs failed with "Invalid value at 'metrics'" for the
// old names, so request the v2 names and map the response headers back to
// the internal canonical keys (CTR, CPC, PAGE_RPM, IMPRESSION_RPM) the UI,
// portfolio aggregation and insights already use. IMPRESSIONS_CTR is the
// clicks/impressions ratio, matching the internal CTR recomputation in
// portfolio-aggregate.ts; PAGE_VIEWS_RPM is revenue per thousand page
// views, matching internal PAGE_RPM.
export const ADSENSE_API_METRICS = [
  "ESTIMATED_EARNINGS",
  "PAGE_VIEWS",
  "IMPRESSIONS",
  "CLICKS",
  "IMPRESSIONS_CTR",
  "COST_PER_CLICK",
  "PAGE_VIEWS_RPM",
  "IMPRESSIONS_RPM",
];
export const ADSENSE_RESPONSE_HEADER_MAP: Record<string, string> = {
  IMPRESSIONS_CTR: "CTR",
  COST_PER_CLICK: "CPC",
  PAGE_VIEWS_RPM: "PAGE_RPM",
  IMPRESSIONS_RPM: "IMPRESSION_RPM",
};
export function parseAdSenseRows(rows: { cells?: { value?: string }[] }[] | undefined, headers: string[]) {
  return (rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    headers.forEach((h, i) => {
      const v = r.cells?.[i]?.value ?? "";
      const n = Number(v);
      out[h] = v !== "" && !Number.isNaN(n) ? n : v;
    });
    return out;
  });
}
/** Provider totals keyed by header name (DATA-9): the raw totals array is
 *  positional and unusable by the UI without the header mapping. Numeric
 *  cells are coerced to numbers; anything else stays a string. */
export function parseAdSenseTotals(
  totals: { cells?: { value?: string }[] } | null | undefined,
  headers: string[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  headers.forEach((h, i) => {
    const v = totals?.cells?.[i]?.value ?? "";
    const n = Number(v);
    out[h] = v !== "" && !Number.isNaN(n) ? n : v;
  });
  return out;
}
/** A-GGL-08: strict YYYY-MM-DD parsing (parseAdManagerDate-style) —
// the old slice-based dateParts admitted "2026-1-5" (month NaN),
// "2026-02-30" and "not-a-date", which the API then rejected with a
// generic provider 502 instead of a clean client-side validation error.
// Throws ADSENSE_INVALID_DATE before any provider call is made. */
function dateParts(d: string) {
  try {
    return parseStrictDate(d);
  } catch {
    throw new Error("ADSENSE_INVALID_DATE");
  }
}
export async function runAdSenseReport(
  auth: OAuth2Client,
  accountId: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ["DATE"],
  metrics: string[] = ADSENSE_API_METRICS,
) {
  // Validate before constructing the client so an invalid range never
  // reaches Google (and no provider call is made at all).
  const s = dateParts(startDate);
  const e = dateParts(endDate);
  if (startDate > endDate) throw new Error("ADSENSE_INVALID_DATE");
  const adsense = google.adsense({ version: "v2", auth });
  // A-GGL-03: bounded like every other googleapis call (see timeout.ts).
  const res = await withGoogleTimeout(
    adsense.accounts.reports.generate(
      {
        account: `accounts/${accountId}`,
        dateRange: "CUSTOM",
        "startDate.year": s.year,
        "startDate.month": s.month,
        "startDate.day": s.day,
        "endDate.year": e.year,
        "endDate.month": e.month,
        "endDate.day": e.day,
        dimensions,
        metrics,
      },
      { timeout: GOOGLE_API_TIMEOUT_MS },
    ),
    "adsense.reports.generate",
  );
  const headers = (res.data.headers ?? []).map((h: { name?: string | null }) => h.name ?? "");
  // Map v2 response headers back to the internal canonical keys so every
  // downstream consumer (snapshots, portfolio aggregation, insights, UI)
  // keeps reading CTR / CPC / PAGE_RPM / IMPRESSION_RPM.
  const mappedHeaders = headers.map((h) => ADSENSE_RESPONSE_HEADER_MAP[h] ?? h);
  const rows = parseAdSenseRows(res.data.rows as { cells?: { value?: string }[] }[] | undefined, mappedHeaders);
  const totals =
    (res.data.totals as { cells?: { value?: string }[] } | undefined)?.cells?.map((c) => c.value ?? "") ?? [];
  const totalsByMetric = parseAdSenseTotals(
    res.data.totals as { cells?: { value?: string }[] } | undefined,
    mappedHeaders,
  );
  // A-GGL-09: the AdSense v2 API caps GenerateReport rows (default
  // 100,000, also the maximum permitted `limit`) and reports the full
  // match count in `total_matched_rows` — there is no pageToken to page
  // with, so detection is exactly the comparison the API docs name:
  // rows returned vs `total_matched_rows`. Mirror GA4
  // (`truncated: rowCount > rows.length`) so callers never treat a
  // truncated detail set as complete. Portfolio aggregation reads
  // `totalsByMetric` (provider-computed over the full range), so the
  // totals stay correct even when the rows are a prefix — the flag is
  // what lets the UI say so. When the API omits the count, fall back
  // to the returned row count (not truncated).
  const rawMatched = (res.data as { totalMatchedRows?: string | null }).totalMatchedRows;
  const parsedMatched = rawMatched != null ? Number(rawMatched) : Number.NaN;
  const rowCount = Number.isFinite(parsedMatched) ? parsedMatched : rows.length;
  const truncated = rowCount > rows.length;
  return {
    accountId,
    startDate,
    endDate,
    headers: mappedHeaders,
    rows,
    rowCount,
    truncated,
    totals,
    totalsByMetric,
    note: ADSENSE_ESTIMATED_NOTE,
  };
}
