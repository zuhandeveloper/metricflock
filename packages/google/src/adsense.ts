import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
import { GOOGLE_API_TIMEOUT_MS, withGoogleTimeout } from "./timeout";
// AdSense figures are ESTIMATED earnings, not finalized payments.
export const ADSENSE_ESTIMATED_NOTE = "AdSense figures are estimated earnings, not finalized payments.";
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
function dateParts(d: string) {
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) };
}
export async function runAdSenseReport(
  auth: OAuth2Client,
  accountId: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ["DATE"],
  metrics: string[] = [
    "ESTIMATED_EARNINGS",
    "PAGE_VIEWS",
    "IMPRESSIONS",
    "CLICKS",
    "CTR",
    "CPC",
    "PAGE_RPM",
    "IMPRESSION_RPM",
  ],
) {
  const adsense = google.adsense({ version: "v2", auth });
  const s = dateParts(startDate);
  const e = dateParts(endDate);
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
  const rows = parseAdSenseRows(res.data.rows as { cells?: { value?: string }[] }[] | undefined, headers);
  const totals =
    (res.data.totals as { cells?: { value?: string }[] } | undefined)?.cells?.map((c) => c.value ?? "") ?? [];
  const totalsByMetric = parseAdSenseTotals(res.data.totals as { cells?: { value?: string }[] } | undefined, headers);
  return { accountId, startDate, endDate, headers, rows, totals, totalsByMetric, note: ADSENSE_ESTIMATED_NOTE };
}
