import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { prisma } from "@metricflock/db";
import { readSnapshot } from "@metricflock/db/snapshots";
import { getPrimaryIntegration } from "@metricflock/google/client";
import { buildCacheKey } from "@metricflock/shared";
import { resolveRange } from "@/lib/analytics-response";

// Public API v1 — per-website analytics from synced snapshots.
// Snapshot-only by design: API keys never trigger live Google calls,
// so a leaked key cannot burn the org's Google quota. Reports map to
// the same providers/sources as the dashboard routes.
const REPORTS: Record<string, { provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER"; source: string }> = {
  overview: { provider: "GA4", source: "ga4" },
  traffic: { provider: "GA4", source: "ga4" },
  audience: { provider: "GA4", source: "ga4" },
  pages: { provider: "GA4", source: "ga4" },
  events: { provider: "GA4", source: "ga4" },
  "search-console": { provider: "SEARCH_CONSOLE", source: "search-console" },
  adsense: { provider: "ADSENSE", source: "adsense" },
  "ad-manager": { provider: "AD_MANAGER", source: "ad-manager" },
};

async function get(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiKey(req, "websites:read");
  if ("error" in auth) return auth.error;
  const { id: websiteId } = await ctx.params;
  const report = req.nextUrl.searchParams.get("report") ?? "overview";
  const range = req.nextUrl.searchParams.get("range") ?? "28d";
  const cfg = REPORTS[report];
  if (!cfg)
    return apiError("invalid_report", 400, {
      message: `report must be one of: ${Object.keys(REPORTS).join(", ")}`,
    });

  const website = await prisma.website.findFirst({
    where: { id: websiteId, organizationId: auth.organizationId },
    select: { id: true },
  });
  if (!website) return apiError("website_not_found", 404);

  const integration = await getPrimaryIntegration(websiteId, cfg.provider).catch(() => null);
  if (!integration) return NextResponse.json({ status: "no_property_mapped", data: null, report, websiteId });
  const { startDate, endDate } = resolveRange(range);
  const cacheKey = buildCacheKey({
    organizationId: auth.organizationId,
    websiteId,
    propertyId: integration.externalId,
    source: cfg.source,
    report,
    range: `${startDate}_${endDate}`,
  });
  const snapshot = await readSnapshot(cacheKey).catch(() => null);
  if (!snapshot)
    return NextResponse.json({
      status: "no_snapshot_yet",
      data: null,
      report,
      websiteId,
      range: { startDate, endDate },
    });
  return NextResponse.json({
    status: "ok",
    data: snapshot.payload,
    report,
    websiteId,
    range: { startDate, endDate },
    snapshotUpdatedAt: snapshot.updatedAt.toISOString(),
    stale: snapshot.expiresAt.getTime() <= Date.now(),
  });
}

export const GET = withApiErrors("v1/websites/analytics", get);
