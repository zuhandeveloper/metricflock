import { describe, it, expect } from "vitest";
import { hasPermission, rolePermissions, PERMISSIONS } from "@metricflock/auth";
describe("permissions", () => {
  it("defines all 17 spec permissions", () => {
    expect(PERMISSIONS).toHaveLength(17);
  });
  it("super admin has every permission", () => {
    for (const p of PERMISSIONS) expect(hasPermission("SUPER_ADMIN", p)).toBe(true);
  });
  it("team member cannot manage teams, connections, transfers or audit", () => {
    for (const p of [
      "team.manage",
      "member.manage",
      "google.connection.manage",
      "website.transfer",
      "audit.view",
      "organization.manage",
    ] as const)
      expect(hasPermission("TEAM_MEMBER", p)).toBe(false);
  });
  it("team admin can manage connections and initiate transfers, but cannot view audit", () => {
    expect(hasPermission("TEAM_ADMIN", "google.connection.manage")).toBe(true);
    // A-API-12: TEAM_ADMIN initiates transfers; the A-SEC-17
    // source-manage check still gates initiation to websites in teams
    // they administer (route-transfers.test.ts covers both cases).
    expect(hasPermission("TEAM_ADMIN", "website.transfer")).toBe(true);
    expect(hasPermission("TEAM_ADMIN", "audit.view")).toBe(false);
  });
  it("team member can view assigned analytics but not realtime", () => {
    expect(hasPermission("TEAM_MEMBER", "analytics.view")).toBe(true);
    expect(hasPermission("TEAM_MEMBER", "analytics.realtime.view")).toBe(false);
  });
  it("rolePermissions is stable", () => {
    expect(rolePermissions("TEAM_ADMIN")).toContain("website.assign");
  });
});
