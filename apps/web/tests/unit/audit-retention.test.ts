import { describe, it, expect, afterEach } from "vitest";
import { auditRetentionDays } from "@metricflock/shared";

// Phase 4 (F-4.3): audit-log retention window parsing. Invalid values
// must fall back to the 365-day default — never to "delete everything".
describe("auditRetentionDays", () => {
  const saved = process.env.AUDIT_RETENTION_DAYS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_RETENTION_DAYS;
    else process.env.AUDIT_RETENTION_DAYS = saved;
  });

  it("defaults to 365 when unset", () => {
    delete process.env.AUDIT_RETENTION_DAYS;
    expect(auditRetentionDays()).toBe(365);
  });
  it("honors a valid positive value", () => {
    process.env.AUDIT_RETENTION_DAYS = "90";
    expect(auditRetentionDays()).toBe(90);
  });
  it("falls back to 365 on invalid or non-positive values", () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      process.env.AUDIT_RETENTION_DAYS = bad;
      expect(auditRetentionDays()).toBe(365);
    }
  });

  // A-COV-11: parsing boundaries of the Number()+floor rule.
  it("floors fractional values and accepts trimmed / exponent forms", () => {
    process.env.AUDIT_RETENTION_DAYS = "90.9";
    expect(auditRetentionDays()).toBe(90);
    process.env.AUDIT_RETENTION_DAYS = "  30  ";
    expect(auditRetentionDays()).toBe(30);
    process.env.AUDIT_RETENTION_DAYS = "1e3";
    expect(auditRetentionDays()).toBe(1000);
  });
  it("falls back to 365 on non-finite values", () => {
    process.env.AUDIT_RETENTION_DAYS = "Infinity";
    expect(auditRetentionDays()).toBe(365);
  });
  // Regression test for the bug A-COV-11 boundary testing found (fixed
  // 2026-11-25): "0.5" is > 0, so it passed the old guard and floored
  // to 0 days. The worker's cutoff is now - 0 * 86_400_000 = now, i.e.
  // "delete everything" — exactly what the docstring says must never
  // happen. The guard now rejects values that floor below 1.
  it("falls back to 365 on a positive value that floors below one day", () => {
    process.env.AUDIT_RETENTION_DAYS = "0.5";
    expect(auditRetentionDays()).toBe(365);
  });
});
