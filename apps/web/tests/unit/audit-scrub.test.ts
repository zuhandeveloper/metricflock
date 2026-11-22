import { describe, it, expect } from "vitest";
import { scrubAuditDetails } from "@metricflock/db/audit";

describe("audit detail scrubbing (DB-10)", () => {
  it("drops credential-looking keys at any depth", () => {
    const out = scrubAuditDetails({
      teamId: "t1",
      accessToken: "x",
      nested: { refresh_token: "y", apiKey: "z", keep: 1 },
      list: [{ password: "p", ok: true }],
      authorization: "Bearer q",
    }) as Record<string, unknown>;
    expect(out).toEqual({ teamId: "t1", nested: { keep: 1 }, list: [{ ok: true }] });
  });
  it("passes through primitives and null", () => {
    expect(scrubAuditDetails(null)).toBeNull();
    expect(scrubAuditDetails("s")).toBe("s");
    expect(scrubAuditDetails(42)).toBe(42);
    expect(scrubAuditDetails({ note: "token count was 3" })).toEqual({ note: "token count was 3" });
  });
  it("redacts secret-shaped VALUES under innocent keys (F-6.7)", () => {
    const out = scrubAuditDetails({
      note: "provider said: invalid token ya29.a0AfH6SMBx7fK9tokenValue",
      error: "refresh 1//0gRefreshTokenValue1234567890 rejected",
      clean: "property 560655306 synced ok",
    }) as Record<string, string>;
    expect(out.note).not.toContain("ya29.");
    expect(out.error).not.toContain("1//0gRefreshTokenValue");
    expect(out.clean).toBe("property 560655306 synced ok");
  });
});
