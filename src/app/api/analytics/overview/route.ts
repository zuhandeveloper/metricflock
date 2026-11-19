import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runHistoricalReport } from "@/lib/google/ga4";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, { permission: "analytics.view", provider: "GA4", source: "ga4", report: "overview", cacheTtlSeconds: 300,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) => runHistoricalReport(getGa4Client(auth), propertyId, startDate, endDate) });
}
