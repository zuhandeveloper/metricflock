import { prisma } from "@metricflock/db";
import { readSnapshot } from "@metricflock/db/snapshots";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { getPrimaryIntegration } from "@metricflock/google/client";
import { buildCacheKey, aggregatePayloads } from "@metricflock/shared";

// Phase 7.1 — portfolio aggregation (DATA-6). Org/team totals are
// computed from per-website DB snapshots (Phase 5), never by fanning
// out live Google calls and never by inventing numbers: a website
// without a snapshot for the range is reported unavailable, and
// metrics that cannot be derived from totals stay null. The
// aggregation math lives in @metricflock/shared (portfolio-aggregate)
// so the worker's report builder shares it (Phase 7.3).
export { aggregatePayloads };

export type PortfolioUser = {
  id: string;
  organizationId: string;
  role: string;
};

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
