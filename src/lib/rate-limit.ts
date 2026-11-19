// In-memory rate limiter (per key, sliding window). Redis-backed limiting lives in queue/cache layer.
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit = 60, windowMs = 60_000): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return { allowed: true, remaining: limit - 1 }; }
  if (b.count >= limit) return { allowed: false, remaining: 0 };
  b.count += 1;
  return { allowed: true, remaining: limit - b.count };
}
