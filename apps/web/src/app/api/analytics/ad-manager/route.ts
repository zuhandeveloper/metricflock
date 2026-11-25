import { NextRequest } from "next/server";
import { apiError, requestIdOf } from "@/lib/api-error";
import { handleAnalyticsRequest } from "@/lib/analytics-handler";
import { runAdManagerReport, adManagerEnabled } from "@metricflock/google/ad-manager";
// A-GGL-03: bound the route wall-clock (60s = Vercel Hobby max). Each
// Google call already times out at 15s; this caps the whole request.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // A-API-10: a disabled provider is a 503 with the stable error code,
  // not a 200 carrying an `error` field — every other analytics failure
  // mode returns 4xx/5xx with `{ error }` (same precedent as
  // `google_oauth_not_configured` → 503). Still before auth: the provider
  // is off for every caller, so there is nothing to authorize.
  if (!adManagerEnabled()) return apiError("ad_manager_disabled", 503, undefined, requestIdOf(req));
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
