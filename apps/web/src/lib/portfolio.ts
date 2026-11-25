import { prisma } from "@metricflock/db";
import { readSnapshots } from "@metricflock/db/snapshots";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { getPrimaryIntegrations } from "@metricflock/google/client";
import { clampSearchConsoleRange } from "@metricflock/google/search-console";
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
  // A-GGL-07: Search Console snapshots are written under the clamped
  // range (worker + handler), so a portfolio read for SC must build its
  // cache keys from the same effective range — otherwise the dashboard
  // page, which calls loadPortfolio directly, would miss every synced
  // SC snapshot. GA4/AdSense/Ad Manager ranges are untouched.
  const { startDate, endDate } =
    opts.provider === "SEARCH_CONSOLE"
      ? clampSearchConsoleRange(opts.startDate, opts.endDate)
      : { startDate: opts.startDate, endDate: opts.endDate };
  const ids = await listAccessibleWebsiteIds(user as never);
  const where =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  // A-WRK-10: the website load is paginated instead of silently capped
  // at 200 — an org with 500 sites used to get totals that omitted 300
  // of them. With no explicit limit the loader pages through every
  // website (200 per page) and the totals cover all of them, so
  // `truncated` is false. An explicit `limit` keeps the old capped
  // behavior (one page, totals over that page, `truncated` when the cap
  // bites) — no caller passes one today.
  const pageSize = opts.limit ?? 200;
  const websiteCount = await prisma.website.count({ where });
  const websites: { id: string; name: string; domain: string }[] = [];
  let skip = 0;
  for (;;) {
    const page = await prisma.website.findMany({
      where,
      select: { id: true, name: true, domain: true },
      orderBy: { createdAt: "asc" },
      skip,
      take: pageSize,
    });
    websites.push(...page);
    if (page.length < pageSize) break;
    if (opts.limit !== undefined) break; // capped: exactly one page
    skip += page.length;
  }
  const entries: PortfolioWebsiteEntry[] = [];
  const unavailableWebsites: { websiteId: string; reason: string }[] = [];
  // A-DB-11: one batched primaries query + one batched snapshot query
  // per page, however many websites the org holds — the per-website
  // getPrimaryIntegration + readSnapshot loop was 2N round-trips. A
  // failed batch degrades the way a failed per-website lookup used to:
  // the affected websites are reported unavailable, never fatal.
  for (let offset = 0; offset < websites.length; offset += pageSize) {
    const page = websites.slice(offset, offset + pageSize);
    const websiteIds = page.map((w) => w.id);
    let primaries: Awaited<ReturnType<typeof getPrimaryIntegrations>>;
    try {
      primaries = await getPrimaryIntegrations(websiteIds, [opts.provider]);
    } catch {
      primaries = new Map();
    }
    const cacheKeys = new Map<string, string>();
    for (const w of page) {
      const integration = primaries.get(w.id)?.get(opts.provider);
      if (!integration) continue;
      cacheKeys.set(
        w.id,
        buildCacheKey({
          organizationId: user.organizationId,
          websiteId: w.id,
          propertyId: integration.externalId,
          source: opts.source,
          report: opts.report,
          range: `${startDate}_${endDate}`,
        }),
      );
    }
    let snapshots: Awaited<ReturnType<typeof readSnapshots>>;
    try {
      snapshots = await readSnapshots([...cacheKeys.values()]);
    } catch {
      snapshots = new Map();
    }
    // Website order (createdAt asc), not Promise.all completion order:
    // the old loop raced, so result order was nondeterministic.
    for (const w of page) {
      const cacheKey = cacheKeys.get(w.id);
      if (!cacheKey) {
        unavailableWebsites.push({ websiteId: w.id, reason: "no_property_mapped" });
        continue;
      }
      const snapshot = snapshots.get(cacheKey);
      if (!snapshot) {
        unavailableWebsites.push({ websiteId: w.id, reason: "no_snapshot_yet" });
        continue;
      }
      entries.push({
        websiteId: w.id,
        name: w.name,
        domain: w.domain,
        snapshotUpdatedAt: snapshot.updatedAt.toISOString(),
        stale: snapshot.expiresAt.getTime() <= Date.now(),
        payload: snapshot.payload,
      });
    }
  }
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
