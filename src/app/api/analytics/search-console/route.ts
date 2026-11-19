import { NextRequest } from "next/server";
import { handleAnalyticsRequest } from "@/lib/analytics-handler";
import { querySearchAnalytics } from "@/lib/google/search-console";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, { permission: "search_console.view", provider: "SEARCH_CONSOLE", source: "search-console", report: "search-console", cacheTtlSeconds: 3600,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) => querySearchAnalytics(auth, propertyId, startDate, endDate, ["date", "query", "page"]) });
}
