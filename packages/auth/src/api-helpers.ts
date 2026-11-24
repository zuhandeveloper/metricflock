import { NextResponse } from "next/server";
import { getSession, getSessionUser } from "./server";
import { hasPermission, type Permission } from "./permissions";
import type { User } from "@metricflock/db";
import { AUTH_RATE_LIMIT_TIERS, authedRateLimitKey, rateLimit, type AuthRateLimitTier } from "@metricflock/shared";

/** Minimal request shape the authed limiter needs: only the route path.
 *  Kept structural (instead of NextRequest) so this package does not
 *  depend on next/server types. */
export type RateLimitRequest = { nextUrl: { pathname: string } };

/** Authenticated rate limit (A-SEC-07 / A-API-05): per user + route
 *  template, fail-closed when Redis is configured (same policy as
 *  login — a Redis outage must not silently lift the brake). Returns
 *  `{ error }` (429 `rate_limited`) when the bucket is empty, so the
 *  client can back off; `{ ok: true }` otherwise. */
export async function requireAuthedRateLimit(
  req: RateLimitRequest,
  user: { id: string },
  tier: AuthRateLimitTier = "default",
): Promise<{ ok: true } | { error: NextResponse }> {
  const { limit, windowMs } = AUTH_RATE_LIMIT_TIERS[tier];
  const res = await rateLimit(authedRateLimitKey(user.id, req.nextUrl.pathname), limit, windowMs, {
    failClosed: true,
  });
  if (res.allowed) return { ok: true };
  return {
    error: NextResponse.json(
      { error: "rate_limited", message: `Rate limit is ${limit} requests/minute for this route.` },
      { status: 429 },
    ),
  };
}

export async function requireApiAuth(
  permission?: Permission,
  opts: { req?: RateLimitRequest; rateLimit?: AuthRateLimitTier | false } = {},
): Promise<{ user: User } | { error: NextResponse }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (permission && !hasPermission(user.role, permission))
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  // A-SEC-07: when the caller passes its request, the authenticated
  // brake applies (per user + route). Callers that do not pass `req`
  // are unthrottled — pass it on every route handler.
  if (opts.req && opts.rateLimit !== false) {
    const limited = await requireAuthedRateLimit(opts.req, user, opts.rateLimit ?? "default");
    if ("error" in limited) return limited;
  }
  return { user };
}

/** Fresh-session window for step-up auth (A-SEC-02). Must match the
 *  better-auth `session.freshAge` configured in `server.ts` (15 min):
 *  better-auth enforces the same boundary on its own sensitive
 *  endpoints (change-password, 2FA, …) via `freshSessionMiddleware`,
 *  which treats a session as fresh while `now - createdAt < freshAge`
 *  (verified in installed better-auth 1.7.26 `dist/api/routes/session.mjs`).
 *  App routes must enforce it themselves — better-auth does not apply it
 *  to our handlers. */
export const FRESH_SESSION_MAX_AGE_SECONDS = 60 * 15;

/** Pure freshness predicate (unit-testable without a session cookie):
 *  a session is fresh while it was created less than `maxAgeSeconds`
 *  ago. Missing or unparsable `createdAt` is never fresh. */
export function isSessionFresh(
  createdAt: Date | string | null | undefined,
  now: Date = new Date(),
  maxAgeSeconds: number = FRESH_SESSION_MAX_AGE_SECONDS,
): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return now.getTime() - created < maxAgeSeconds * 1000;
}

/** Step-up auth (A-SEC-02): require the current session to be fresh
 *  (created within `maxAgeSeconds`) before a destructive or
 *  privilege-minting action (org delete, member role change/delete,
 *  API-key mint/revoke, connection disconnect, transfer completion). Returns `{ error }` with 401
 *  `session_not_fresh` when the session is stale, so the client can
 *  prompt for re-authentication; `{ ok: true }` when fresh. Call after
 *  `requireApiAuth` — unauthenticated callers are already rejected
 *  there, so a missing session here is also reported as not fresh. */
export async function requireFreshSession(
  maxAgeSeconds: number = FRESH_SESSION_MAX_AGE_SECONDS,
): Promise<{ ok: true } | { error: NextResponse }> {
  const session = await getSession().catch(() => null);
  if (!session?.session || !isSessionFresh(session.session.createdAt, new Date(), maxAgeSeconds)) {
    return {
      error: NextResponse.json(
        { error: "session_not_fresh", message: "Please sign in again to continue." },
        { status: 401 },
      ),
    };
  }
  return { ok: true };
}
export function apiError(status: number, error: string, details?: unknown) {
  return NextResponse.json({ error, ...(details ? { details } : {}) }, { status });
}
