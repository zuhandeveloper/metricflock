import { NextResponse } from "next/server";
import { getSession, getSessionUser } from "./server";
import { hasPermission, type Permission } from "./permissions";
import type { User } from "@metricflock/db";
export async function requireApiAuth(permission?: Permission): Promise<{ user: User } | { error: NextResponse }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (permission && !hasPermission(user.role, permission))
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
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
