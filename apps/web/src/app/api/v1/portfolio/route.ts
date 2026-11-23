import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { loadPortfolio } from "@/lib/portfolio";
import { resolveRange } from "@/lib/analytics-response";

// Public API v1 — portfolio totals across the organization's
// websites (Phase 7.1 aggregation over snapshots).
const PROVIDERS = {
  GA4: { source: "ga4", reports: ["overview", "traffic", "audience", "pages", "events"] },
  SEARCH_CONSOLE: { source: "search-console", reports: ["search-console"] },
  ADSENSE: { source: "adsense", reports: ["adsense"] },
  AD_MANAGER: { source: "ad-manager", reports: ["ad-manager"] },
} as const;

async function get(req: NextRequest) {
  const auth = await requireApiKey(req);
  if ("error" in auth) return auth.error;
  const provider = (req.nextUrl.searchParams.get("provider") ?? "GA4") as keyof typeof PROVIDERS;
  const cfg = PROVIDERS[provider];
  if (!cfg)
    return apiError("invalid_provider", 400, {
      message: `provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`,
    });
  const report = req.nextUrl.searchParams.get("report") ?? cfg.reports[0];
  if (!(cfg.reports as readonly string[]).includes(report))
    return apiError("invalid_report", 400, {
      message: `report for ${provider} must be one of: ${cfg.reports.join(", ")}`,
    });
  const { startDate, endDate } = resolveRange(req.nextUrl.searchParams.get("range") ?? "28d");
  const result = await loadPortfolio(auth.user, { provider, source: cfg.source, report, startDate, endDate });
  return NextResponse.json({
    provider,
    report,
    range: { startDate, endDate },
    totals: result.totals,
    totalsNote: result.totalsNote,
    websiteCount: result.websiteCount,
    includedWebsites: result.websites.map((w) => w.websiteId),
    unavailableWebsites: result.unavailableWebsites,
    truncated: result.truncated,
  });
}

export const GET = withApiErrors("v1/portfolio", get);
