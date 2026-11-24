import { NextRequest, NextResponse } from "next/server";
import { handleAnalyticsRequest } from "@/lib/analytics-handler";
import { runAdManagerReport, adManagerEnabled } from "@metricflock/google/ad-manager";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!adManagerEnabled())
    return NextResponse.json({ status: "disabled", error: "GOOGLE_AD_MANAGER_ENABLED is false" }, { status: 200 });
  return handleAnalyticsRequest(req, {
    permission: "ad_manager.view",
    provider: "AD_MANAGER",
    source: "ad-manager",
    report: "ad-manager",
    cacheTtlSeconds: 3600,
    fetchFn: async ({ auth, propertyId, startDate, endDate }) =>
      runAdManagerReport(auth, propertyId, startDate, endDate),
  });
}
