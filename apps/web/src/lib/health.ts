import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { deriveHealthState, HEALTH_STALE_AFTER_MS, type HealthState } from "@metricflock/shared";
import { MAX_OFFSET } from "./pagination";

// Phase 7.2 — integration health overview. Reads the IntegrationHealth
// rows the sync engine maintains (one per website+provider), scoped to
// the websites the caller can access. Bounded + paginated like the
// dashboard; states derive from the shared health-state helpers.

export type HealthRow = {
  websiteId: string;
  websiteName: string;
  domain: string;
  provider: string;
  state: HealthState;
  status: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkedAt: string;
};

export type HealthOverview = {
  summary: { healthy: number; error: number; stale: number; withoutRecord: number };
  rows: HealthRow[];
  total: number;
  page: number;
  pageCount: number;
};

const PAGE_SIZE = 50;

// A-API-09: the page cap, expressed in 50-row pages — the same 10,000-row
// offset cap parsePagination enforces, so page 10⁹ cannot force a huge
// skip. The clamp lives here (not in the two routes or the /health
// page) so every caller gets it.
const MAX_PAGE = Math.floor(MAX_OFFSET / PAGE_SIZE) + 1;

type HealthUser = { id: string; organizationId: string; role: string };

export async function loadHealthOverview(user: HealthUser, page = 1): Promise<HealthOverview> {
  const safePage = Number.isFinite(page) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(page))) : 1;
  const ids = await listAccessibleWebsiteIds(user as never);
  const websiteWhere =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  const healthWhere = { website: websiteWhere };
  const staleBefore = new Date(Date.now() - HEALTH_STALE_AFTER_MS);
  const [total, rows, mappedCount, errorCount, staleCount] = await Promise.all([
    prisma.integrationHealth.count({ where: healthWhere }),
    prisma.integrationHealth.findMany({
      where: healthWhere,
      include: { website: { select: { name: true, domain: true } } },
      orderBy: [{ status: "asc" }, { checkedAt: "desc" }],
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.websiteIntegration.count({
      where: { website: websiteWhere, mappingStatus: "MAPPED" },
    }),
    prisma.integrationHealth.count({ where: { ...healthWhere, status: { not: "ok" } } }),
    prisma.integrationHealth.count({
      where: {
        ...healthWhere,
        status: "ok",
        OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: staleBefore } }],
      },
    }),
  ]);
  const now = new Date();
  const summary = {
    healthy: Math.max(0, total - errorCount - staleCount),
    error: errorCount,
    stale: staleCount,
    withoutRecord: Math.max(0, mappedCount - total),
  };
  return {
    summary,
    rows: rows
      .filter((r) => r.websiteId && r.website)
      .map((r) => ({
        websiteId: r.websiteId as string,
        websiteName: r.website?.name ?? "",
        domain: r.website?.domain ?? "",
        provider: r.provider,
        state: deriveHealthState(r, now),
        status: r.status,
        lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
        lastError: r.lastError,
        checkedAt: r.checkedAt.toISOString(),
      })),
    total,
    page: safePage,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}
