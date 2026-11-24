import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runAudienceReport } from "@metricflock/google/ga4";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.view",
    provider: "GA4",
    source: "ga4",
    report: "audience",
    cacheTtlSeconds: 300,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runAudienceReport(getGa4Client(auth), propertyId, startDate, endDate),
  });
}
