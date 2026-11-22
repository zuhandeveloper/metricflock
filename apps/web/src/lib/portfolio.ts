import { prisma } from "@metricflock/db";
import { readSnapshot } from "@metricflock/db/snapshots";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { getPrimaryIntegration } from "@metricflock/google/client";
import { buildCacheKey } from "@metricflock/shared";

// Phase 7.1 — portfolio aggregation (DATA-6). Org/team totals are
// computed from per-website DB snapshots (Phase 5), never by fanning
// out live Google calls and never by inventing numbers: a website
// without a snapshot for the range is reported unavailable, and
// metrics that cannot be derived from totals stay null.

export type PortfolioWebsiteEntry = {
  websiteId: string;
  name: string;
  domain: string;
  snapshotUpdatedAt: string;
  stale: boolean;
  payload: unknown;
};

export type PortfolioResult = {
  totals: Record<string, number | null> | null;
  totalsNote: string | null;
  websites: PortfolioWebsiteEntry[];
  unavailableWebsites: { websiteId: string; reason: string }[];
  websiteCount: number;
  truncated: boolean;
};

const GA4_ADDITIVE = [
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagedSessions",
  "eventCount",
  "keyEvents",
] as const;

type Num = number | null | undefined;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sumOrNull = (values: Num[]): number | null => {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((s, v) => s + v, 0) : null;
};
const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

/** Pure aggregation over per-website report payloads. Exported for tests. */
export function aggregatePayloads(
  report: string,
  payloads: unknown[],
): { totals: Record<string, number | null> | null; note: string | null } {
  if (report === "overview") {
    const summaries = payloads.map(
      (p) => ((p as { summary?: Record<string, unknown> })?.summary ?? {}) as Record<string, unknown>,
    );
    const totals: Record<string, number | null> = {};
    for (const m of GA4_ADDITIVE) totals[m] = sumOrNull(summaries.map((s) => num(s[m])));
    totals.engagementRate = ratio(totals.engagedSessions, totals.sessions);
    totals.bounceRate = totals.engagementRate === null ? null : 1 - totals.engagementRate;
    totals.sessionConversionRate = ratio(totals.keyEvents, totals.sessions);
    // Cannot be derived from per-property totals (needs raw durations).
    totals.averageEngagementTime = null;
    return {
      totals,
      note: "activeUsers/newUsers are sums across properties — a person visiting two websites counts twice. Rates are recomputed from summed totals; averageEngagementTime cannot be aggregated and is null.",
    };
  }
  if (report === "search-console") {
    const ts = payloads.map(
      (p) => ((p as { totals?: Record<string, unknown> })?.totals ?? {}) as Record<string, unknown>,
    );
    const clicks = sumOrNull(ts.map((t) => num(t.clicks)));
    const impressions = sumOrNull(ts.map((t) => num(t.impressions)));
    const weighted = ts.reduce((s, t) => {
      const pos = num(t.avgPosition);
      const imp = num(t.impressions);
      return pos === null || imp === null ? s : s + pos * imp;
    }, 0);
    return {
      totals: {
        clicks,
        impressions,
        avgCtr: ratio(clicks, impressions),
        avgPosition: impressions ? weighted / impressions : null,
      },
      note: "avgPosition is impression-weighted across properties; avgCtr is recomputed from summed clicks/impressions.",
    };
  }
  if (report === "adsense") {
    const ts = payloads.map(
      (p) => ((p as { totalsByMetric?: Record<string, unknown> })?.totalsByMetric ?? {}) as Record<string, unknown>,
    );
    const metric = (name: string) =>
      sumOrNull(
        ts.map((t) => {
          const v = t[name];
          return typeof v === "string" && v !== "" ? Number(v) : num(v);
        }),
      );
    const earnings = metric("ESTIMATED_EARNINGS");
    const pageViews = metric("PAGE_VIEWS");
    const impressions = metric("IMPRESSIONS");
    const clicks = metric("CLICKS");
    return {
      totals: {
        ESTIMATED_EARNINGS: earnings,
        PAGE_VIEWS: pageViews,
        IMPRESSIONS: impressions,
        CLICKS: clicks,
        CTR: ratio(clicks, impressions),
        CPC: ratio(earnings, clicks),
        PAGE_RPM: pageViews ? ((earnings ?? 0) / pageViews) * 1000 : null,
        IMPRESSION_RPM: impressions ? ((earnings ?? 0) / impressions) * 1000 : null,
      },
      note: "AdSense figures are estimated earnings, not finalized payments. Rates are recomputed from summed totals.",
    };
  }
  return { totals: null, note: "aggregation_not_supported_for_report" };
}

type PortfolioUser = { id: string; organizationId: string; role: string };

/** Load snapshots for every accessible website (bounded) and aggregate. */
export async function loadPortfolio(
  user: PortfolioUser,
  opts: {
    provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
    source: string;
    report: string;
    startDate: string;
    endDate: string;
    limit?: number;
  },
): Promise<PortfolioResult> {
  const limit = opts.limit ?? 200;
  const ids = await listAccessibleWebsiteIds(user as never);
  const where =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  const [websiteCount, websites] = await Promise.all([
    prisma.website.count({ where }),
    prisma.website.findMany({
      where,
      select: { id: true, name: true, domain: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    }),
  ]);
  const entries: PortfolioWebsiteEntry[] = [];
  const unavailableWebsites: { websiteId: string; reason: string }[] = [];
  await Promise.all(
    websites.map(async (w) => {
      const integration = await getPrimaryIntegration(w.id, opts.provider).catch(() => null);
      if (!integration) {
        unavailableWebsites.push({ websiteId: w.id, reason: "no_property_mapped" });
        return;
      }
      const cacheKey = buildCacheKey({
        organizationId: user.organizationId,
        websiteId: w.id,
        propertyId: integration.externalId,
        source: opts.source,
        report: opts.report,
        range: `${opts.startDate}_${opts.endDate}`,
      });
      const snapshot = await readSnapshot(cacheKey).catch(() => null);
      if (!snapshot) {
        unavailableWebsites.push({ websiteId: w.id, reason: "no_snapshot_yet" });
        return;
      }
      entries.push({
        websiteId: w.id,
        name: w.name,
        domain: w.domain,
        snapshotUpdatedAt: snapshot.updatedAt.toISOString(),
        stale: snapshot.expiresAt.getTime() <= Date.now(),
        payload: snapshot.payload,
      });
    }),
  );
  const { totals, note } = aggregatePayloads(
    opts.report,
    entries.map((e) => e.payload),
  );
  return {
    totals,
    totalsNote: note,
    websites: entries,
    unavailableWebsites,
    websiteCount,
    truncated: websiteCount > websites.length,
  };
}
