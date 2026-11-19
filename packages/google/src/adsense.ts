import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
// AdSense figures are ESTIMATED earnings, not finalized payments.
export const ADSENSE_ESTIMATED_NOTE = "AdSense figures are estimated earnings, not finalized payments.";
export function parseAdSenseRows(rows: { cells?: { value?: string }[] }[] | undefined, headers: string[]) {
  return (rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    headers.forEach((h, i) => { const v = r.cells?.[i]?.value ?? ""; const n = Number(v); out[h] = v !== "" && !Number.isNaN(n) ? n : v; });
    return out;
  });
}
function dateParts(d: string) { return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) }; }
export async function runAdSenseReport(auth: OAuth2Client, accountId: string, startDate: string, endDate: string, dimensions: string[] = ["DATE"], metrics: string[] = ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "IMPRESSIONS", "CLICKS", "CTR", "CPC", "PAGE_RPM", "IMPRESSION_RPM"]) {
  const adsense = google.adsense({ version: "v2", auth });
  const s = dateParts(startDate);
  const e = dateParts(endDate);
  const res = await adsense.accounts.reports.generate({
    account: `accounts/${accountId}`,
    dateRange: "CUSTOM",
    "startDate.year": s.year, "startDate.month": s.month, "startDate.day": s.day,
    "endDate.year": e.year, "endDate.month": e.month, "endDate.day": e.day,
    dimensions, metrics,
  });
  const headers = (res.data.headers ?? []).map((h: { name?: string | null }) => h.name ?? "");
  const rows = parseAdSenseRows(res.data.rows as { cells?: { value?: string }[] }[] | undefined, headers);
  const totals = (res.data.totals as { cells?: { value?: string }[] } | undefined)?.cells?.map((c) => c.value ?? "") ?? [];
  return { accountId, startDate, endDate, headers, rows, totals, note: ADSENSE_ESTIMATED_NOTE };
}
