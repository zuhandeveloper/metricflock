import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runAudienceReport } from "@/lib/google/ga4";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, { permission: "analytics.view", provider: "GA4", source: "ga4", report: "audience", cacheTtlSeconds: 300,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) => runAudienceReport(getGa4Client(auth), propertyId, startDate, endDate) });
}
