// DB analytics snapshots (Phase 5, F-5.4 hybrid): the durable layer
// under the Redis cache. The worker's scheduled syncs and the web
// app's live fetches both write snapshots keyed by the SAME cache key
// as Redis; reads serve Redis first, then a fresh snapshot, then live.
// Snapshots survive Redis eviction/restarts and make portfolio-level
// aggregation possible later. Expired rows are pruned by the worker
// scheduler (Phase 4 retention).
import { prisma } from "./client";

export type Snapshot = { payload: unknown; expiresAt: Date; updatedAt: Date };

/** Upsert a snapshot for a cache key. `ttlSeconds` is the freshness
 * window (callers pass max(cache TTL, sync interval) — see
 * snapshotTtlSeconds in @metricflock/jobs). */
export async function writeSnapshot(
  cacheKey: string,
  websiteId: string,
  payload: unknown,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await prisma.analyticsCache.upsert({
    where: { cacheKey },
    update: { payload: payload as object, expiresAt, websiteId },
    create: { cacheKey, websiteId, payload: payload as object, expiresAt },
  });
}

/** Read a snapshot by cache key (fresh or stale — the caller decides
 * whether stale is acceptable, mirroring cacheGet's contract). */
export async function readSnapshot(cacheKey: string): Promise<Snapshot | null> {
  const row = await prisma.analyticsCache.findUnique({
    where: { cacheKey },
    select: { payload: true, expiresAt: true, createdAt: true },
  });
  if (!row) return null;
  return { payload: row.payload, expiresAt: row.expiresAt, updatedAt: row.createdAt };
}

/** Drop every snapshot for one website (mapping/assignment/website
 * changes — mirrors invalidateWebsiteCache for Redis). */
export async function invalidateWebsiteSnapshots(websiteId: string): Promise<void> {
  await prisma.analyticsCache.deleteMany({ where: { websiteId } }).catch(() => undefined);
}

/** Drop every snapshot for one organization (connection changes —
 * mirrors invalidateOrgCache). Cache keys are
 * `analytics:{organizationId}:...` by construction. */
export async function invalidateOrgSnapshots(organizationId: string): Promise<void> {
  await prisma.analyticsCache
    .deleteMany({ where: { cacheKey: { startsWith: `analytics:${organizationId}:` } } })
    .catch(() => undefined);
}
