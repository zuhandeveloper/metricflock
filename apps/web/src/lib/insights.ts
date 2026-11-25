import { prisma } from "@metricflock/db";
import { readSnapshots } from "@metricflock/db/snapshots";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { getPrimaryIntegrations } from "@metricflock/google/client";
import { clampSearchConsoleRange } from "@metricflock/google/search-console";
import {
  buildCacheKey,
  seoInsights,
  revenueInsights,
  channelMix,
  aggregatePayloads,
  type SeoInsights,
  type RevenueInsights,
  type ChannelShare,
} from "@metricflock/shared";
import { type PortfolioUser } from "./portfolio";
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
  // A-API-09: true when the per-website list is capped at MAX_WEBSITES
  // — same shape as loadPortfolio's `truncated`.
  truncated: boolean;
};

const MAX_WEBSITES = 50;

// A-DB-11: the summary totals used to come from two loadPortfolio
// calls, each over its own 200-website list. The single pass below
// loads that same 200-website set once and aggregates the same
// snapshots, so the totals are unchanged.
const PORTFOLIO_WEBSITES = 200;

export async function loadInsights(user: PortfolioUser): Promise<InsightsResult> {
  const range = resolveRange("28d");
  const ids = await listAccessibleWebsiteIds(user as never);
  const where =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  // One website list serves both passes: the per-website insights take
  // the first MAX_WEBSITES (same createdAt order as before), the
  // summary totals take the first PORTFOLIO_WEBSITES.
  // A-API-09: `truncated` is derived from the fetched list length —
  // no extra query. The list is capped at PORTFOLIO_WEBSITES (200),
  // which exceeds MAX_WEBSITES (50), so `websites.length > 50` holds
  // exactly when more websites are accessible than the per-website
  // list holds — the same comparison loadPortfolio makes with its
  // count (`websiteCount > websites.length`). (Summary totals still
  // cover the first 200, the pre-existing A-DB-11 behaviour; only the
  // per-website list is flagged here.)
  const websites = await prisma.website.findMany({
    where,
    select: { id: true, name: true, domain: true },
    orderBy: { createdAt: "asc" },
    take: PORTFOLIO_WEBSITES,
  });
  const insightWebsites = websites.slice(0, MAX_WEBSITES);

  // A-DB-11: one batched primaries query for all three providers and
  // one batched snapshot query for every report the page needs. The old
  // code issued 6 queries per website, then ran loadPortfolio twice —
  // each re-running the access list, the website list and the same
  // per-website lookups. A failed batch degrades the way a failed
  // per-website lookup used to: the affected snapshots are simply
  // missing, never fatal.
  const websiteIds = websites.map((w) => w.id);
  let primaries: Awaited<ReturnType<typeof getPrimaryIntegrations>>;
  try {
    primaries = await getPrimaryIntegrations(websiteIds, ["GA4", "SEARCH_CONSOLE", "ADSENSE"]);
  } catch {
    primaries = new Map();
  }
  const rangeKey = `${range.startDate}_${range.endDate}`;
  // A-GGL-07: the Search Console snapshot key uses the clamped range —
  // the worker warms it and the SC route reads it — while the GA4 and
  // AdSense keys keep the unclamped 28d range. The returned `range`
  // stays the requested 28d window: it covers three providers, and only
  // the SC slice inside it is clamped.
  const scRange = clampSearchConsoleRange(range.startDate, range.endDate);
  const scRangeKey = `${scRange.startDate}_${scRange.endDate}`;
  const keyFor = (
    websiteId: string,
    provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE",
    source: string,
    report: string,
    keyRange: string = rangeKey,
  ): string | null => {
    const integration = primaries.get(websiteId)?.get(provider);
    if (!integration) return null;
    return buildCacheKey({
      organizationId: user.organizationId,
      websiteId,
      propertyId: integration.externalId,
      source,
      report,
      range: keyRange,
    });
  };
  // The AdSense insight report and the AdSense portfolio report share
  // one cache key (adsense/adsense), so the Set dedupes them.
  const keys = new Set<string>();
  const insightKeys = new Map<string, { sc: string | null; adsense: string | null; traffic: string | null }>();
  for (const w of insightWebsites) {
    const sc = keyFor(w.id, "SEARCH_CONSOLE", "search-console", "search-console", scRangeKey);
    const adsense = keyFor(w.id, "ADSENSE", "adsense", "adsense");
    const traffic = keyFor(w.id, "GA4", "ga4", "traffic");
    insightKeys.set(w.id, { sc, adsense, traffic });
    for (const k of [sc, adsense, traffic]) if (k) keys.add(k);
  }
  const overviewKeys = new Map<string, string>();
  const adsenseKeys = new Map<string, string>();
  for (const w of websites) {
    const overview = keyFor(w.id, "GA4", "ga4", "overview");
    if (overview) {
      overviewKeys.set(w.id, overview);
      keys.add(overview);
    }
    const adsense = keyFor(w.id, "ADSENSE", "adsense", "adsense");
    if (adsense) {
      adsenseKeys.set(w.id, adsense);
      keys.add(adsense);
    }
  }
  let snapshots: Awaited<ReturnType<typeof readSnapshots>>;
  try {
    snapshots = await readSnapshots([...keys]);
  } catch {
    snapshots = new Map();
  }

  const perWebsite: WebsiteInsights[] = [];
  let unavailableCount = 0;
  for (const w of insightWebsites) {
    const k = insightKeys.get(w.id);
    const sc = k?.sc ? (snapshots.get(k.sc)?.payload ?? null) : null;
    const adsense = k?.adsense ? (snapshots.get(k.adsense)?.payload ?? null) : null;
    const traffic = k?.traffic ? (snapshots.get(k.traffic)?.payload ?? null) : null;
    if (!sc && !adsense && !traffic) {
      unavailableCount += 1;
      continue;
    }
    perWebsite.push({
      websiteId: w.id,
      name: w.name,
      domain: w.domain,
      seo: sc ? seoInsights(sc) : null,
      revenue: adsense ? revenueInsights(adsense) : null,
      channels: traffic ? channelMix(traffic) : [],
    });
  }
  perWebsite.sort((a, b) => a.name.localeCompare(b.name));

  // Summary totals over the 200-website set, exactly as the two
  // loadPortfolio calls computed them (aggregatePayloads is a pure sum,
  // so order is irrelevant; a website without a snapshot contributes
  // nothing, as before).
  const ga4Payloads: unknown[] = [];
  for (const w of websites) {
    const key = overviewKeys.get(w.id);
    const snap = key ? snapshots.get(key) : undefined;
    if (snap) ga4Payloads.push(snap.payload);
  }
  const adsPayloads: unknown[] = [];
  for (const w of websites) {
    const key = adsenseKeys.get(w.id);
    const snap = key ? snapshots.get(key) : undefined;
    if (snap) adsPayloads.push(snap.payload);
  }
  const ga4 = aggregatePayloads("overview", ga4Payloads);
  const ads = aggregatePayloads("adsense", adsPayloads);
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
    truncated: websites.length > MAX_WEBSITES,
  };
}
