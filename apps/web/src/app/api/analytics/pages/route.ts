import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { toCsv } from "@/lib/csv";
import { runPagesReport } from "@metricflock/google/ga4";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.view",
    provider: "GA4",
    source: "ga4",
    report: "pages",
    cacheTtlSeconds: 300,
    csv: (data) => {
      const d = data as { rows?: Record<string, string | number>[] };
      return toCsv(d.rows ?? []);
    },
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runPagesReport(getGa4Client(auth), propertyId, startDate, endDate),
  });
}
