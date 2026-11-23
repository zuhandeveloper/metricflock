import { prisma } from "@metricflock/db";
import { readSnapshot } from "@metricflock/db/snapshots";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { getPrimaryIntegration } from "@metricflock/google/client";
import {
  buildCacheKey,
  seoInsights,
  revenueInsights,
  channelMix,
  type SeoInsights,
  type RevenueInsights,
  type ChannelShare,
} from "@metricflock/shared";
import { loadPortfolio, type PortfolioUser } from "./portfolio";
import { resolveRange } from "./analytics-response";

// Phase 7.4 — SEO/revenue intelligence. Per-website insights derived
// from the same 28-day snapshots the sync engine writes (Search
// Console query/page rows, AdSense daily rows, GA4 traffic rows).
// A website without a snapshot contributes nothing and is counted as
// unavailable — numbers are never invented.

export type WebsiteInsights = {
  websiteId: string;
  name: string;
  domain: string;
  seo: SeoInsights | null;
  revenue: RevenueInsights | null;
  channels: ChannelShare[];
};

export type InsightsResult = {
  range: { startDate: string; endDate: string };
  summary: {
    totalEarnings: number | null;
    blendedPageRpm: number | null;
    earningsPerThousandSessions: number | null;
    strikingDistanceQueries: number;
    lowCtrQueries: number;
  };
  websites: WebsiteInsights[];
  unavailableCount: number;
};

const MAX_WEBSITES = 50;

async function snapshotFor(
  organizationId: string,
  websiteId: string,
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE",
  source: string,
  report: string,
  range: { startDate: string; endDate: string },
): Promise<unknown | null> {
  const integration = await getPrimaryIntegration(websiteId, provider).catch(() => null);
  if (!integration) return null;
  const cacheKey = buildCacheKey({
    organizationId,
    websiteId,
    propertyId: integration.externalId,
    source,
    report,
    range: `${range.startDate}_${range.endDate}`,
  });
  const snapshot = await readSnapshot(cacheKey).catch(() => null);
  return snapshot?.payload ?? null;
}

export async function loadInsights(user: PortfolioUser): Promise<InsightsResult> {
  const range = resolveRange("28d");
  const ids = await listAccessibleWebsiteIds(user as never);
  const where =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  const websites = await prisma.website.findMany({
    where,
    select: { id: true, name: true, domain: true },
    orderBy: { createdAt: "asc" },
    take: MAX_WEBSITES,
  });

  const perWebsite: WebsiteInsights[] = [];
  let unavailableCount = 0;
  await Promise.all(
    websites.map(async (w) => {
      const [sc, adsense, traffic] = await Promise.all([
        snapshotFor(user.organizationId, w.id, "SEARCH_CONSOLE", "search-console", "search-console", range),
        snapshotFor(user.organizationId, w.id, "ADSENSE", "adsense", "adsense", range),
        snapshotFor(user.organizationId, w.id, "GA4", "ga4", "traffic", range),
      ]);
      if (!sc && !adsense && !traffic) {
        unavailableCount += 1;
        return;
      }
      perWebsite.push({
        websiteId: w.id,
        name: w.name,
        domain: w.domain,
        seo: sc ? seoInsights(sc) : null,
        revenue: adsense ? revenueInsights(adsense) : null,
        channels: traffic ? channelMix(traffic) : [],
      });
    }),
  );
  perWebsite.sort((a, b) => a.name.localeCompare(b.name));

  const [ga4, ads] = await Promise.all([
    loadPortfolio(user, { ...range, provider: "GA4", source: "ga4", report: "overview" }),
    loadPortfolio(user, { ...range, provider: "ADSENSE", source: "adsense", report: "adsense" }),
  ]);
  const earnings = ads.totals?.ESTIMATED_EARNINGS ?? null;
  const sessions = ga4.totals?.sessions ?? null;
  return {
    range,
    summary: {
      totalEarnings: earnings,
      blendedPageRpm: ads.totals?.PAGE_RPM ?? null,
      earningsPerThousandSessions: earnings !== null && sessions ? (earnings / sessions) * 1000 : null,
      strikingDistanceQueries: perWebsite.reduce((s, w) => s + (w.seo?.strikingDistance.length ?? 0), 0),
      lowCtrQueries: perWebsite.reduce((s, w) => s + (w.seo?.lowCtr.length ?? 0), 0),
    },
    websites: perWebsite,
    unavailableCount,
  };
}
