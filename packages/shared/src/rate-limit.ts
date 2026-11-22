import { getRedis } from "./cache";
import { incr } from "./metrics";
import { createLogger } from "./logger";

// Rate limiter (OPS-1): Redis-backed fixed window when Redis is configured
// (shared across instances — serverless replicas no longer multiply the
// limit), in-memory fallback otherwise (dev/sandbox without Redis).
// The Redis path is atomic via Lua: INCR + PEXPIRE-on-first-hit in one
// round trip, so concurrent requests cannot race past the limit.
//
// F-3.1 policy: callers on sensitive endpoints (login, OAuth connect /
// callback, invites) pass `failClosed: true` — when Redis is configured
// but unreachable, the request is REJECTED instead of silently degrading
// to per-process limits that multiply per instance. Non-sensitive callers
// (provider quota protection in the worker) keep the degraded fallback.
// Every degradation path is counted (ratelimit.* counters, exposed on
// /api/metrics) so a Redis outage is visible instead of silent.
const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

const log = createLogger("rate-limit");
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

export type RateLimitOptions = {
  /** Reject when Redis is configured but unreachable (sensitive endpoints). */
  failClosed?: boolean;
};

export async function rateLimit(
  key: string,
  limit = 60,
  windowMs = 60_000,
  opts: RateLimitOptions = {},
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  if (!redis) {
    // No Redis configured at all: explicit single-instance mode (dev).
    const res = inMemoryRateLimit(key, limit, windowMs);
    if (!res.allowed) incr("ratelimit.rejected");
    return res;
  }
  try {
    const [count] = (await redis.eval(RATE_LIMIT_LUA, 1, `ratelimit:${key}`, windowMs)) as [number, number];
    const allowed = count <= limit;
    if (!allowed) incr("ratelimit.rejected");
    return { allowed, remaining: Math.max(0, limit - count) };
  } catch (e) {
    incr("ratelimit.redis_error");
    if (opts.failClosed) {
      incr("ratelimit.fail_closed");
      log.error("Redis unreachable — failing closed for sensitive rate limit", { key });
      return { allowed: false, remaining: 0 };
    }
    incr("ratelimit.fallback");
    log.warn("Redis unreachable — degraded to per-process rate limiting", { key });
    const res = inMemoryRateLimit(key, limit, windowMs);
    if (!res.allowed) incr("ratelimit.rejected");
    return res;
  }
}

/** Client IP for rate-limit keys (F-3.1). Prefers `x-real-ip`, which the
 * hosting platform (Vercel) sets from the actual connection and clients
 * cannot spoof through it; falls back to the FIRST `x-forwarded-for`
 * entry (the original client as appended by the first trusted proxy).
 * Never key on the raw header value — a client-supplied multi-entry
 * header would otherwise mint a fresh bucket per spoofed prefix. */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
}
