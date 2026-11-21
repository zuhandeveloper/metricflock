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

/** Connection OPTIONS for BullMQ (OPS-10): BullMQ must own dedicated
 *  connections (its blocking commands serialize on a shared socket) and
 *  requires maxRetriesPerRequest: null. Passing options instead of the
 *  shared cache client lets BullMQ create one connection per Queue/Worker.
 *  Returns null when REDIS_URL is unset (queues disabled, as before). */
export function bullConnectionOptions(): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls?: object;
  maxRetriesPerRequest: null;
} | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.protocol === "rediss:" ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
    };
  } catch {
    return null;
  }
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
/** Delete keys matching a pattern via SCAN (OPS-6): KEYS is O(N) and blocks
 *  the shared Redis; SCAN iterates in bounded cursor batches. */
async function scanDelete(r: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (keys.length) await r.del(...keys);
  } while (cursor !== "0");
}

export async function invalidateWebsiteCache(organizationId: string, websiteId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await scanDelete(r, `analytics:${organizationId}:${websiteId}:*`);
  } catch {
    /* best-effort */
  }
}
export async function invalidateOrgCache(organizationId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await scanDelete(r, `analytics:${organizationId}:*`);
  } catch {
    /* best-effort */
  }
}
