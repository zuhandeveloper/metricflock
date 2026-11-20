import { describe, it, expect, beforeAll } from "vitest";
beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-min-32-chars-long!!";
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/google/oauth/callback";
});
import { buildState, verifyState, buildAuthUrl, ALL_SCOPES } from "@metricflock/google/oauth";
describe("OAuth state", () => {
  it("builds and verifies a state token", () => {
    const s = buildState("TEAM", "team-1", "user-1");
    expect(verifyState(s)).toEqual(expect.objectContaining({ ownerType: "TEAM", ownerId: "team-1", userId: "user-1" }));
  });
  it("rejects tampered state", () => {
    const s = buildState("WEBSITE", "w-1", "u-1");
    const tampered = s.slice(0, -2) + "AA";
    expect(() => verifyState(tampered)).toThrow();
  });
  it("rejects expired state", () => {
    const s = buildState("TEAM", "t", "u");
    expect(() => verifyState(s, 0)).toThrow("STATE_EXPIRED");
  });
  it("auth URL requests offline access and least-privilege read-only scopes", () => {
    const url = new URL(buildAuthUrl("TEAM", "t", "u"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    const scope = url.searchParams.get("scope") ?? "";
    for (const s of ALL_SCOPES) expect(scope).toContain(s);
    expect(scope).not.toContain("analytics.edit");
  });
});
