import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runTrafficAcquisition } from "@metricflock/google/ga4";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.view",
    provider: "GA4",
    source: "ga4",
    report: "traffic",
    cacheTtlSeconds: 300,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runTrafficAcquisition(getGa4Client(auth), propertyId, startDate, endDate),
  });
}
