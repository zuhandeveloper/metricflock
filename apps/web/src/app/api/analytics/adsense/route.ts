import { NextRequest } from "next/server";
import { handleAnalyticsRequest } from "@/lib/analytics-handler";
import { runAdSenseReport } from "@metricflock/google/adsense";
import { toCsv } from "@/lib/csv";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "adsense.view",
    provider: "ADSENSE",
    source: "adsense",
    report: "adsense",
    cacheTtlSeconds: 3600,
    csv: (data) => toCsv(((data as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]),
    fetchFn: async ({ auth, propertyId, startDate, endDate }) => runAdSenseReport(auth, propertyId, startDate, endDate),
  });
}
