import { NextRequest } from "next/server";
import { handleAnalyticsRequest, getGa4Client } from "@/lib/analytics-handler";
import { runPagesReport } from "@metricflock/google/ga4";
export async function GET(req: NextRequest) {
  return handleAnalyticsRequest(req, {
    permission: "analytics.view",
    provider: "GA4",
    source: "ga4",
    report: "pages",
    cacheTtlSeconds: 300,
    csv: (data) => {
      const d = data as { rows?: Record<string, string | number>[] };
      const rows = d.rows ?? [];
      const head = rows[0] ? Object.keys(rows[0]).join(",") : "";
      return [head, ...rows.map((r) => Object.values(r).join(","))].join("\n");
    },
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runPagesReport(getGa4Client(auth), propertyId, startDate, endDate),
  });
}
