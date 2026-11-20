import { describe, it, expect } from "vitest";
import { websiteCreateSchema, mapPropertySchema } from "@metricflock/shared";

// Stage 2 regression tests (audit API-11, DB-7/API-7 request contract).
describe("websiteCreateSchema status (API-11)", () => {
  const base = { name: "Site", domain: "example.com", url: "https://example.com" };
  it("accepts client-settable statuses", () => {
    for (const status of ["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "ARCHIVED"] as const) {
      expect(websiteCreateSchema.safeParse({ ...base, status }).success).toBe(true);
    }
  });
  it("rejects server-managed statuses TRANSFER_PENDING and SOLD", () => {
    expect(websiteCreateSchema.safeParse({ ...base, status: "TRANSFER_PENDING" }).success).toBe(false);
    expect(websiteCreateSchema.safeParse({ ...base, status: "SOLD" }).success).toBe(false);
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
