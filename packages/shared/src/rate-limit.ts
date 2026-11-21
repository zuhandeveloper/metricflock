import { getRedis } from "./cache";

// Rate limiter (OPS-1): Redis-backed fixed window when Redis is configured
// (shared across instances — serverless replicas no longer multiply the
// limit), in-memory fallback otherwise (dev/sandbox without Redis).
// The Redis path is atomic via Lua: INCR + PEXPIRE-on-first-hit in one
// round trip, so concurrent requests cannot race past the limit.
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

const buckets = new Map<string, { count: number; resetAt: number }>();

function inMemoryRateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number } {
  const now = Date.now();
  // Opportunistic cleanup so the fallback map cannot grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  if (b.count >= limit) return { allowed: false, remaining: 0 };
  b.count += 1;
  return { allowed: true, remaining: limit - b.count };
}

export async function rateLimit(
  key: string,
  limit = 60,
  windowMs = 60_000,
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  if (!redis) return inMemoryRateLimit(key, limit, windowMs);
  try {
    const [count] = (await redis.eval(RATE_LIMIT_LUA, 1, `ratelimit:${key}`, windowMs)) as [number, number];
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    // Redis hiccup: degrade to per-process limiting rather than failing open
    // entirely or breaking the request path.
    return inMemoryRateLimit(key, limit, windowMs);
  }
}
