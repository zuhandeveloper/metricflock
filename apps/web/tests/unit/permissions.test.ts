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

  // A-COV-11: pin the full role×permission matrix, not just spot checks.
  it("pins the exact permission set of every role", () => {
    expect(rolePermissions("SUPER_ADMIN")).toEqual([...PERMISSIONS]);
    expect(rolePermissions("TEAM_ADMIN")).toEqual([
      "analytics.view",
      "analytics.realtime.view",
      "analytics.reports.view",
      "search_console.view",
      "adsense.view",
      "ad_manager.view",
      "website.view",
      "website.manage",
      "website.assign",
      "website.transfer",
      "team.view",
      "team.manage",
      "member.manage",
      "google.connection.view",
      "google.connection.manage",
    ]);
    expect(rolePermissions("TEAM_MEMBER")).toEqual([
      "analytics.view",
      "analytics.reports.view",
      "search_console.view",
      "adsense.view",
      "website.view",
    ]);
  });

  it("team admin is denied exactly audit.view and organization.manage", () => {
    const denied = PERMISSIONS.filter((p) => !hasPermission("TEAM_ADMIN", p));
    expect(denied).toEqual(["audit.view", "organization.manage"]);
  });

  it("team member is denied every management and realtime permission", () => {
    for (const p of [
      "analytics.realtime.view",
      "ad_manager.view",
      "website.manage",
      "website.assign",
      "team.view",
      "team.manage",
      "member.manage",
      "google.connection.view",
      "google.connection.manage",
      "website.transfer",
      "audit.view",
      "organization.manage",
    ] as const)
      expect(hasPermission("TEAM_MEMBER", p)).toBe(false);
  });

  it("extra grants extend a role without leaking to other permissions", () => {
    expect(hasPermission("TEAM_MEMBER", "audit.view", ["audit.view"])).toBe(true);
    expect(hasPermission("TEAM_MEMBER", "organization.manage", ["audit.view"])).toBe(false);
    expect(hasPermission("TEAM_MEMBER", "audit.view", [])).toBe(false);
    expect(hasPermission("TEAM_ADMIN", "audit.view", ["audit.view"])).toBe(true);
  });

  it("an unknown role has no permissions", () => {
    expect(rolePermissions("NOPE" as never)).toEqual([]);
    expect(hasPermission("NOPE" as never, "analytics.view")).toBe(false);
    expect(hasPermission("NOPE" as never, "analytics.view", ["analytics.view"])).toBe(true);
  });
});
