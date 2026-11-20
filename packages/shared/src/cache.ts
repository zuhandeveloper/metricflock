import Redis from "ioredis";
// Lazy Redis client: app builds and runs without Redis; caching degrades to no-op.
let redis: Redis | null = null;
let redisTried = false;
export function getRedis(): Redis | null {
  if (redisTried) return redis;
  redisTried = true;
  if (!process.env.REDIS_URL) return null;
  try {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false });
    redis.on("error", () => {
      /* degrade silently; cache is best-effort */
    });
  } catch {
    redis = null;
  }
  return redis;
}
export function buildCacheKey(parts: {
  organizationId: string;
  websiteId?: string;
  propertyId?: string;
  source: string;
  report: string;
  range: string;
  filters?: string;
}): string {
  return [
    "analytics",
    parts.organizationId,
    parts.websiteId ?? "org",
    parts.propertyId ?? "none",
    parts.source,
    parts.report,
    parts.range,
    parts.filters ?? "all",
  ].join(":");
}
export async function cacheGet<T>(key: string): Promise<{ value: T; stale: boolean } | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; expiresAt: number };
    return { value: parsed.value, stale: Date.now() > parsed.expiresAt };
  } catch {
    return null;
  }
}
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify({ value, expiresAt: Date.now() + ttlSeconds * 1000 }), "EX", ttlSeconds * 2);
  } catch {
    /* best-effort */
  }
}
export async function invalidateWebsiteCache(organizationId: string, websiteId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const keys = await r.keys(`analytics:${organizationId}:${websiteId}:*`);
    if (keys.length) await r.del(...keys);
  } catch {
    /* best-effort */
  }
}
export async function invalidateOrgCache(organizationId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    const keys = await r.keys(`analytics:${organizationId}:*`);
    if (keys.length) await r.del(...keys);
  } catch {
    /* best-effort */
  }
}
