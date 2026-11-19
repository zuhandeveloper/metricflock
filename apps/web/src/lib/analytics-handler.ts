import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { assertWebsiteAccess, listAccessibleWebsiteIds } from "@metricflock/auth";
import { analyticsQuerySchema } from "@metricflock/shared";
import { analyticsEnvelope, notConnectedEnvelope, missingDataEnvelope, resolveRange } from "./analytics-response";
import { buildCacheKey, cacheGet, cacheSet } from "@metricflock/shared";
import { getAuthorizedClientForWebsite, getPrimaryIntegration } from "@metricflock/google/client";
import { getGa4Client } from "@metricflock/google/ga4";
import { lastSuccessfulSync } from "@metricflock/db/health";
import type { Permission } from "@metricflock/auth";
import type { OAuth2Client } from "@metricflock/google/auth-types";

export type AnalyticsFetchContext = { auth: OAuth2Client; propertyId: string; websiteId: string; startDate: string; endDate: string };

/** Shared analytics pipeline: auth -> permission -> website access -> connection
 *  resolution -> primary mapping -> cache -> real Google call -> envelope.
 *  Never invents metrics; missing connection/property returns an explicit status. */
export async function handleAnalyticsRequest(
  req: NextRequest,
  opts: {
    permission: Permission;
    provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
    source: string;
    report: string;
    cacheTtlSeconds: number;
    csv?: (data: unknown) => string;
    fetchFn: (ctx: AnalyticsFetchContext) => Promise<unknown>;
  },
): Promise<NextResponse> {
  const auth = await requireApiAuth(opts.permission);
  if ("error" in auth) return auth.error;
  const parsed = analyticsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input", details: parsed.error.issues }, { status: 400 });
  const { websiteId, range, startDate, endDate, format } = parsed.data;
  const { startDate: sd, endDate: ed } = resolveRange(range, startDate, endDate);
  if (!websiteId) {
    // Org-wide aggregate: list accessible websites and report which are unavailable.
    const ids = await listAccessibleWebsiteIds(auth.user);
    const where = ids === null ? { organizationId: auth.user.organizationId } : { organizationId: auth.user.organizationId, id: { in: ids } };
    const { prisma } = await import("@metricflock/db");
    const websites = await prisma.website.findMany({ where, select: { id: true } });
    return analyticsEnvelope({
      data: { note: "Aggregate across websites is computed per-website; call with ?websiteId= for live Google data. No metrics are invented for unconnected sites.", websiteCount: websites.length },
      includedWebsites: [], unavailableWebsites: websites.map((w) => ({ websiteId: w.id, reason: "aggregate_requires_per_website_call" })),
      dataSource: opts.source, freshness: "unavailable", range: { startDate: sd, endDate: ed },
    });
  }
  const website = await assertWebsiteAccess(auth.user, websiteId).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const integration = await getPrimaryIntegration(websiteId, opts.provider);
  if (!integration) return missingDataEnvelope(websiteId, `No ${opts.provider} property mapped to this website.`);
  let client: Awaited<ReturnType<typeof getAuthorizedClientForWebsite>>;
  try { client = await getAuthorizedClientForWebsite(websiteId); }
  catch (e) { const m = e instanceof Error ? e.message : ""; if (m === "CONNECTION_REQUIRED") return notConnectedEnvelope(websiteId); return NextResponse.json({ error: m || "connection_error" }, { status: 502 }); }
  const cacheKey = buildCacheKey({ organizationId: auth.user.organizationId, websiteId, propertyId: integration.externalId, source: opts.source, report: opts.report, range: `${sd}_${ed}` });
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached && !cached.stale) {
    return analyticsEnvelope({ data: cached.value, websiteId, includedWebsites: [websiteId], unavailableWebsites: [], lastSyncedAt: await lastSuccessfulSync(websiteId, opts.report), dataSource: opts.source, freshness: "cached", range: { startDate: sd, endDate: ed } });
  }
  try {
    const data = await opts.fetchFn({ auth: client.auth, propertyId: integration.externalId, websiteId, startDate: sd, endDate: ed });
    await cacheSet(cacheKey, data, opts.cacheTtlSeconds);
    if (format === "csv" && opts.csv) {
      return new NextResponse(opts.csv(data), { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${opts.report}-${websiteId}.csv"` } });
    }
    return analyticsEnvelope({ data, websiteId, includedWebsites: [websiteId], unavailableWebsites: [], lastSyncedAt: await lastSuccessfulSync(websiteId, opts.report), dataSource: opts.source, freshness: cached ? "stale-while-revalidate" : "live", range: { startDate: sd, endDate: ed } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "google_api_error";
    const quota = /quota|rateLimitExceeded|429/i.test(msg);
    return NextResponse.json({ error: quota ? "google_quota_exceeded" : "google_api_error", details: msg }, { status: quota ? 429 : 502 });
  }
}
export { getGa4Client };
