import { describe, it, expect } from "vitest";
import {
  websiteCreateSchema,
  mapPropertySchema,
  dateRangeSchema,
  analyticsQuerySchema,
  teamCreateSchema,
  transferSchema,
  inviteCreateSchema,
  memberRoleSchema,
  parseStrictDate,
  isValidCalendarDate,
} from "@metricflock/shared";

// A-GGL-08: the shared date schema used to accept impossible dates
// ("2026-02-30", "2026-13-45") — a format regex cannot tell a real
// calendar date from a well-shaped one. Now both fields are strictly
// validated, so the handler returns 400 invalid_input before any
// provider call.
describe("dateRangeSchema strict dates (A-GGL-08)", () => {
  it("accepts real calendar dates", () => {
    expect(dateRangeSchema.safeParse({ range: "custom", startDate: "2026-01-01", endDate: "2026-01-31" }).success).toBe(
      true,
    );
    expect(dateRangeSchema.safeParse({ range: "custom", startDate: "2024-02-29", endDate: "2024-03-01" }).success).toBe(
      true,
    );
  });

  it("rejects impossible and non-padded dates", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-01-32", "2025-02-29", "2026-1-5", "not-a-date"]) {
      expect(dateRangeSchema.safeParse({ range: "custom", startDate: bad, endDate: "2026-02-28" }).success).toBe(false);
      expect(dateRangeSchema.safeParse({ range: "custom", startDate: "2026-02-01", endDate: bad }).success).toBe(false);
    }
  });

  it("still accepts presets with no dates", () => {
    expect(dateRangeSchema.safeParse({ range: "28d" }).success).toBe(true);
  });
});

describe("parseStrictDate / isValidCalendarDate (A-GGL-08)", () => {
  it("parses real dates and rejects impossible ones", () => {
    expect(parseStrictDate("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseStrictDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(() => parseStrictDate("2026-02-30")).toThrow("INVALID_DATE");
    expect(() => parseStrictDate("2026-1-5")).toThrow("INVALID_DATE");
    expect(isValidCalendarDate("2026-02-28")).toBe(true);
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
  });
});

// Stage 2 regression tests (audit API-11, DB-7/API-7 request contract).
// A-FE-09: SOLD became client-settable (no server-side sale flow exists,
// so the edit-website select is the only path to it); TRANSFER_PENDING
// stays transfer-flow-owned and rejected.
describe("websiteCreateSchema status (API-11, A-FE-09)", () => {
  const base = { name: "Site", domain: "example.com", url: "https://example.com" };
  it("accepts client-settable statuses", () => {
    for (const status of ["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "SOLD", "ARCHIVED"] as const) {
      expect(websiteCreateSchema.safeParse({ ...base, status }).success).toBe(true);
    }
  });
  it("rejects the transfer-flow-owned status TRANSFER_PENDING", () => {
    expect(websiteCreateSchema.safeParse({ ...base, status: "TRANSFER_PENDING" }).success).toBe(false);
  });
});

describe("mapPropertySchema (DB-7)", () => {
  it("accepts an optional connectionId for disambiguation", () => {
    const parsed = mapPropertySchema.safeParse({
      websiteId: "w1",
      provider: "GA4",
      externalId: "properties/123",
      connectionId: "c1",
    });
    expect(parsed.success).toBe(true);
  });
  it("still accepts requests without connectionId", () => {
    const parsed = mapPropertySchema.safeParse({ websiteId: "w1", provider: "GA4", externalId: "properties/123" });
    expect(parsed.success).toBe(true);
  });
});

// A-COV-08: the remaining 5 schemas were used by live routes/handlers
// (teams, transfer, invite, member role, analytics query) with no test
// asserting accept/reject or error paths. Table-driven: valid / each
// invalid field / boundary values, with the failing field's issue path
// asserted so a wrong-field error cannot hide behind a generic reject.
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("dateRangeSchema range enum + defaults (A-COV-08)", () => {
  it("defaults range to 28d when omitted", () => {
    const parsed = dateRangeSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.range).toBe("28d");
  });

  it("accepts every preset range", () => {
    for (const range of ["today", "yesterday", "7d", "28d", "90d", "12m", "custom"] as const) {
      expect(dateRangeSchema.safeParse({ range }).success).toBe(true);
    }
  });

  it("rejects range values outside the enum, naming the field", () => {
    for (const range of ["30d", "1y", "all", ""]) {
      const result = dateRangeSchema.safeParse({ range });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("range");
    }
  });
});

describe("teamCreateSchema (A-COV-08)", () => {
  const valid = { name: "Acme Team", slug: "acme-team-1" };

  it("accepts valid input and boundary lengths", () => {
    expect(teamCreateSchema.safeParse(valid).success).toBe(true);
    expect(teamCreateSchema.safeParse({ name: "A".repeat(200), slug: "s".repeat(100) }).success).toBe(true);
    expect(teamCreateSchema.safeParse({ name: "A", slug: "a" }).success).toBe(true);
  });

  it("rejects each invalid field, naming it", () => {
    const cases: { input: unknown; path: string }[] = [
      { input: { ...valid, name: "" }, path: "name" },
      { input: { ...valid, name: "A".repeat(201) }, path: "name" },
      { input: { name: "Acme" }, path: "slug" },
      { input: { ...valid, slug: "" }, path: "slug" },
      { input: { ...valid, slug: "s".repeat(101) }, path: "slug" },
      { input: { ...valid, slug: "My Team" }, path: "slug" },
      { input: { ...valid, slug: "team_name" }, path: "slug" },
      { input: { ...valid, slug: "team!" }, path: "slug" },
      { input: { ...valid, slug: "TEAM" }, path: "slug" },
    ];
    for (const { input, path } of cases) {
      const result = teamCreateSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(path);
    }
  });

  it("partial() (used by the PATCH route) accepts an empty or single-field body", () => {
    expect(teamCreateSchema.partial().safeParse({}).success).toBe(true);
    expect(teamCreateSchema.partial().safeParse({ name: "Renamed" }).success).toBe(true);
    expect(teamCreateSchema.partial().safeParse({ slug: "Bad Slug!" }).success).toBe(false);
  });
});

describe("transferSchema (A-COV-08)", () => {
  it("accepts a bare toTeamId and a reason at the 1000-char boundary", () => {
    expect(transferSchema.safeParse({ toTeamId: "t1" }).success).toBe(true);
    expect(transferSchema.safeParse({ toTeamId: "t1", reason: "R".repeat(1000) }).success).toBe(true);
  });

  it("rejects each invalid field, naming it", () => {
    const cases: { input: unknown; path: string }[] = [
      { input: {}, path: "toTeamId" },
      { input: { toTeamId: "" }, path: "toTeamId" },
      { input: { toTeamId: "t1", reason: "R".repeat(1001) }, path: "reason" },
    ];
    for (const { input, path } of cases) {
      const result = transferSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(path);
    }
  });
});

describe("analyticsQuerySchema (A-COV-08)", () => {
  it("accepts an empty query (range defaults to 28d) and full valid queries", () => {
    const empty = analyticsQuerySchema.safeParse({});
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.range).toBe("28d");
    expect(
      analyticsQuerySchema.safeParse({
        range: "custom",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        websiteId: "w1",
        format: "csv",
      }).success,
    ).toBe(true);
    expect(analyticsQuerySchema.safeParse({ range: "7d", format: "json" }).success).toBe(true);
  });

  it("rejects each invalid field, naming it", () => {
    const cases: { input: unknown; path: string }[] = [
      { input: { range: "30d" }, path: "range" },
      { input: { format: "xml" }, path: "format" },
      { input: { range: "custom", startDate: "2026-02-30", endDate: "2026-03-01" }, path: "startDate" },
      { input: { range: "custom", startDate: "2026-01-01", endDate: "2026-13-01" }, path: "endDate" },
      { input: { websiteId: 42 }, path: "websiteId" },
    ];
    for (const { input, path } of cases) {
      const result = analyticsQuerySchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(path);
    }
  });

  // A-GGL-22: the cross-field order check lives on the schema too, so a
  // reversed range fails validation (400 invalid_input) before any
  // provider call — resolveRange keeps its own check as defense-in-depth.
  it("rejects startDate after endDate, naming startDate; equal dates pass", () => {
    for (const input of [
      { range: "custom", startDate: "2026-02-10", endDate: "2026-02-01" },
      { startDate: "2026-02-10", endDate: "2026-02-01" },
    ]) {
      const result = analyticsQuerySchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("startDate");
    }
    expect(
      analyticsQuerySchema.safeParse({ range: "custom", startDate: "2026-02-01", endDate: "2026-02-01" }).success,
    ).toBe(true);
  });
});

describe("inviteCreateSchema (A-COV-08)", () => {
  it("accepts a valid email, defaulting role to TEAM_MEMBER", () => {
    const parsed = inviteCreateSchema.safeParse({ email: "teammate@example.com" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.role).toBe("TEAM_MEMBER");
    expect(inviteCreateSchema.safeParse({ email: "admin@example.com", role: "TEAM_ADMIN" }).success).toBe(true);
  });

  it("accepts an email at the 320-char boundary", () => {
    expect(inviteCreateSchema.safeParse({ email: `${"a".repeat(308)}@example.com` }).success).toBe(true);
  });

  it("rejects each invalid field, naming it", () => {
    const cases: { input: unknown; path: string }[] = [
      { input: { email: "not-an-email" }, path: "email" },
      { input: { email: "" }, path: "email" },
      { input: {}, path: "email" },
      // 321 chars: well-shaped email, over the length cap.
      { input: { email: `${"a".repeat(309)}@example.com` }, path: "email" },
      // SUPER_ADMIN is never granted by invite (promoted afterwards).
      { input: { email: "a@example.com", role: "SUPER_ADMIN" }, path: "role" },
      { input: { email: "a@example.com", role: "OWNER" }, path: "role" },
    ];
    for (const { input, path } of cases) {
      const result = inviteCreateSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain(path);
    }
  });
});

describe("memberRoleSchema (A-COV-08)", () => {
  it("accepts all three roles", () => {
    for (const role of ["SUPER_ADMIN", "TEAM_ADMIN", "TEAM_MEMBER"] as const) {
      expect(memberRoleSchema.safeParse({ role }).success).toBe(true);
    }
  });

  it("rejects unknown or miscased roles and a missing role, naming the field", () => {
    for (const input of [{ role: "OWNER" }, { role: "admin" }, { role: "team_admin" }, {}]) {
      const result = memberRoleSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain("role");
    }
  });
});
