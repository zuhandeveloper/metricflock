import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runRealtimeReport } from "@metricflock/google/ga4";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, { permission: "analytics.realtime.view", provider: "GA4", source: "ga4", report: "realtime", cacheTtlSeconds: 30,
    fetchFn: async ({ auth, propertyId }) => runRealtimeReport(getGa4Client(auth), propertyId) });
}
