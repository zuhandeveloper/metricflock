import { NextRequest } from "next/server";
import { handleAnalyticsRequest } from "@/lib/analytics-handler";
import { runAdSenseReport } from "@metricflock/google/adsense";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "adsense.view",
    provider: "ADSENSE",
    source: "adsense",
    report: "adsense",
    cacheTtlSeconds: 3600,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) => runAdSenseReport(auth, propertyId, startDate, endDate),
  });
}
