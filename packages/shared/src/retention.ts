// Retention policy helpers (Phase 4, F-4.3 —
// docs/security/data-lifecycle.md). Shared so the worker scheduler and
// tests read the same parsing rule.

/** Audit-log retention window in days (AUDIT_RETENTION_DAYS env).
 * Defaults to 365; invalid, non-positive, or sub-day values fall back
 * to 365 — never to "delete everything". */
export function auditRetentionDays(): number {
  const raw = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
  return Number.isFinite(raw) && Math.floor(raw) >= 1 ? Math.floor(raw) : 365;
}
