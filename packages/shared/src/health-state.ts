// Integration-health state derivation + alert transitions (Phase 7.2).
// Pure helpers shared by the web health overview and the worker's
// alerting recordHealth wrapper, so both agree on what "healthy",
// "error", and "stale" mean.

export type HealthState = "healthy" | "error" | "stale";

/** A provider that last succeeded longer ago than this is "stale" —
 * checks run hourly, so 48h without a success means something is
 * quietly broken even if the last recorded status was ok. */
export const HEALTH_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export function deriveHealthState(
  row: { status: string; lastSuccessAt: Date | string | null },
  now: Date = new Date(),
  staleAfterMs: number = HEALTH_STALE_AFTER_MS,
): HealthState {
  if (row.status !== "ok") return "error";
  if (!row.lastSuccessAt) return "stale";
  const last = row.lastSuccessAt instanceof Date ? row.lastSuccessAt : new Date(row.lastSuccessAt);
  return now.getTime() - last.getTime() > staleAfterMs ? "stale" : "healthy";
}

export type HealthTransition = "alert_error" | "recovered" | null;

/** Alert only on transitions, never on every repeated check: a
 * provider flapping into error emails once, and its recovery emails
 * once. A first-ever record that is already an error also alerts —
 * the connection was broken from the start. */
export function healthTransition(prevStatus: string | null, nextStatus: string): HealthTransition {
  if (nextStatus !== "ok" && prevStatus !== nextStatus) return "alert_error";
  if (nextStatus === "ok" && prevStatus !== null && prevStatus !== "ok") return "recovered";
  return null;
}
