import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runHistoricalReport } from "@metricflock/google/ga4";
import { toCsv } from "@/lib/csv";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.view",
    provider: "GA4",
    source: "ga4",
    report: "overview",
    cacheTtlSeconds: 300,
    csv: (data) => toCsv(((data as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[]),
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runHistoricalReport(getGa4Client(auth), propertyId, startDate, endDate),
  });
}
