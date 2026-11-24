import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runRealtimeReport } from "@metricflock/google/ga4";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.realtime.view",
    provider: "GA4",
    source: "ga4",
    report: "realtime",
    cacheTtlSeconds: 30,
    fetchFn: async ({ auth, propertyId }) => runRealtimeReport(getGa4Client(auth), propertyId),
  });
}
