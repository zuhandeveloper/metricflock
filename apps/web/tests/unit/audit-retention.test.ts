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
});
