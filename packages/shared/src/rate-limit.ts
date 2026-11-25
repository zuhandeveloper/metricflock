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
// to per-process limits that multiply per instance. The worker's
// per-connection Google quota guard also fails closed (A-GGL-19): a
// Redis error delays the sync job instead of letting every instance
// fetch against the per-project Google quota unthrottled. Other
// non-sensitive callers keep the degraded fallback.
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

/** Whether proxy headers may be trusted for client identity (A-SEC-05).
 *  Trust only when the deployment sits behind a proxy that overwrites
 *  them: an explicit `TRUST_PROXY=1`/`true`, or Vercel (`VERCEL=1` is set
 *  by the platform itself — Vercel's edge overwrites `x-real-ip` from
 *  the TCP connection, so clients cannot spoof through it). An explicit
 *  `TRUST_PROXY=0`/`false` always wins over the Vercel default. */
export function isProxyTrusted(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.TRUST_PROXY?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return env.VERCEL === "1";
}

/** Client IP for rate-limit keys (F-3.1, A-SEC-05). When the proxy is
 *  trusted, prefers `x-real-ip`, which the hosting platform sets from
 *  the actual connection; falls back to the FIRST `x-forwarded-for`
 *  entry (the original client as appended by the first trusted proxy).
 *  Never key on the raw header value — a client-supplied multi-entry
 *  header would otherwise mint a fresh bucket per spoofed prefix.
 *
 *  When the proxy is NOT trusted (self-host without a proxy in front),
 *  both headers are client-spoofable and are ignored entirely: every
 *  caller keys on `"unknown"` (one shared bucket) instead of a forgeable
 *  per-request identity. Next.js route handlers expose no socket
 *  address, so there is no better untrusted-mode identifier — the
 *  shared bucket fails closed (abuse is throttled) at the cost of
 *  shared-bucket contention on unauthenticated endpoints. Set
 *  `TRUST_PROXY=1` only when a proxy that overwrites these headers
 *  actually sits in front of the app. */
export function clientIpFromHeaders(
  headers: { get(name: string): string | null },
  opts: { trustProxy?: boolean } = {},
): string {
  const trust = opts.trustProxy ?? isProxyTrusted();
  if (!trust) return "unknown";
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapse ID-like path segments to `{id}` so a rate-limit key is per
 *  route template, not per concrete resource — otherwise varying the id
 *  in the URL would mint a fresh bucket per request (same spoof class
 *  as A-SEC-05). IDs in this app are cuid (25 chars), nanoid (21) or
 *  UUID (36); every static segment of the API is ≤ 16 chars, so the
 *  length rule cannot collapse a real static segment — and if a future
 *  static segment ever exceeds it, the failure mode is over-limiting
 *  (buckets merge), never under-limiting. */
export function normalizeRateLimitPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (seg.length > 16 || UUID_RE.test(seg) ? "{id}" : seg))
    .join("/");
}

/** Per-user-per-route limits for authenticated API routes (A-SEC-07 /
 *  A-API-05): default 60/min for ordinary reads/writes; strict 20/min
 *  for Google-touching or otherwise expensive routes (analytics,
 *  property discovery, org export, manual sync, report test sends). */
export type AuthRateLimitTier = "default" | "strict";
export const AUTH_RATE_LIMIT_TIERS: Record<AuthRateLimitTier, { limit: number; windowMs: number }> = {
  default: { limit: 60, windowMs: 60_000 },
  strict: { limit: 20, windowMs: 60_000 },
};

/** Bucket key for the authenticated limiter: per user + route template. */
export function authedRateLimitKey(userId: string, pathname: string): string {
  return `authed:${userId}:${normalizeRateLimitPath(pathname)}`;
}
