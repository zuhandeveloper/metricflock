import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@metricflock/db";

// A-COV-02 (Stage 1, row 15): unit tests for every assert/visibility
// function in packages/auth/src/tenant.ts. Positive + negative +
// cross-org cases. These tests must FAIL if a check is removed —
// verified by a mutation check (negate one assert, suite goes red).
const mocks = vi.hoisted(() => ({
  teamFindFirst: vi.fn(),
  teamMemberFindFirst: vi.fn(),
  teamMemberFindMany: vi.fn(),
  websiteFindFirst: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteAssignmentFindFirst: vi.fn(),
  websiteAssignmentFindMany: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    team: { findFirst: mocks.teamFindFirst },
    teamMember: { findFirst: mocks.teamMemberFindFirst, findMany: mocks.teamMemberFindMany },
    website: { findFirst: mocks.websiteFindFirst, findMany: mocks.websiteFindMany },
    websiteAssignment: {
      findFirst: mocks.websiteAssignmentFindFirst,
      findMany: mocks.websiteAssignmentFindMany,
    },
  },
}));

import {
  assertTeamAccess,
  assertTeamManageAccess,
  assertConnectionScopeForWebsite,
  assertWebsiteAccess,
  assertWebsiteManageAccess,
  assertConnectionOwnerAccess,
  connectionVisibilityWhere,
  assertConnectionVisible,
  listAccessibleWebsiteIds,
} from "@metricflock/auth";

const user = (over: Partial<User> = {}): User =>
  ({
    id: "u1",
    organizationId: "org1",
    role: "SUPER_ADMIN",
    email: "admin@example.com",
    ...over,
  }) as unknown as User;

const team = (over: Record<string, unknown> = {}) => ({ id: "t1", organizationId: "org1", ...over });
const website = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  organizationId: "org1",
  teamId: "t1",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teamMemberFindMany.mockResolvedValue([]);
  mocks.websiteFindMany.mockResolvedValue([]);
  mocks.websiteAssignmentFindMany.mockResolvedValue([]);
  mocks.websiteAssignmentFindFirst.mockResolvedValue(null);
  mocks.teamMemberFindFirst.mockResolvedValue(null);
  mocks.websiteFindFirst.mockResolvedValue(null);
  mocks.teamFindFirst.mockResolvedValue(null);
});

describe("assertTeamAccess", () => {
  it("SUPER_ADMIN can access a team in their own org", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    await expect(assertTeamAccess(user(), "t1")).resolves.toEqual(team());
    expect(mocks.teamFindFirst).toHaveBeenCalledWith({
      where: { id: "t1", organizationId: "org1" },
    });
  });
  it("SUPER_ADMIN cannot access a team from another org (404, not 403)", async () => {
    mocks.teamFindFirst.mockResolvedValue(null);
    await expect(assertTeamAccess(user(), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a team admin member can access their team", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true, team: team() });
    await expect(assertTeamAccess(user({ role: "TEAM_ADMIN" }), "t1")).resolves.toEqual(team());
  });
  it("a plain TEAM_MEMBER with membership can access (view-level)", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false, team: team() });
    await expect(assertTeamAccess(user({ role: "TEAM_MEMBER" }), "t1")).resolves.toEqual(team());
  });
  it("a TEAM_ADMIN who is not an admin of the team is FORBIDDEN", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false, team: team() });
    await expect(assertTeamAccess(user({ role: "TEAM_ADMIN" }), "t1")).rejects.toThrow("FORBIDDEN");
  });
  it("a non-member cannot access the team", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    await expect(assertTeamAccess(user({ role: "TEAM_MEMBER" }), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a membership whose team belongs to another org is denied", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true, team: team({ organizationId: "org2" }) });
    await expect(assertTeamAccess(user({ role: "TEAM_MEMBER" }), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
});

describe("assertTeamManageAccess", () => {
  it("SUPER_ADMIN can manage a team in their org", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    await expect(assertTeamManageAccess(user(), "t1")).resolves.toEqual(team());
  });
  it("missing / foreign team throws", async () => {
    mocks.teamFindFirst.mockResolvedValue(null);
    await expect(assertTeamManageAccess(user(), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("an isAdmin member can manage the team", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    await expect(assertTeamManageAccess(user({ role: "TEAM_ADMIN" }), "t1")).resolves.toEqual(team());
  });
  it("a non-admin member cannot manage the team, even as TEAM_ADMIN role", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false });
    await expect(assertTeamManageAccess(user({ role: "TEAM_ADMIN" }), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a non-member cannot manage the team", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    await expect(assertTeamManageAccess(user({ role: "TEAM_MEMBER" }), "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
});

describe("assertConnectionScopeForWebsite (pure)", () => {
  const teamConn = { teamId: "t1", websiteId: null, ownerType: "TEAM", ownerId: "t1" };
  const siteConn = { teamId: null, websiteId: "w1", ownerType: "WEBSITE", ownerId: "w1" };
  it("team connection serves a website of the same team", () => {
    expect(() => assertConnectionScopeForWebsite(teamConn, { id: "w1", teamId: "t1" })).not.toThrow();
  });
  it("team connection cannot serve another team's website", () => {
    expect(() => assertConnectionScopeForWebsite(teamConn, { id: "w2", teamId: "t2" })).toThrow(
      "NOT_FOUND_OR_FORBIDDEN",
    );
  });
  it("website connection serves exactly its own website", () => {
    expect(() => assertConnectionScopeForWebsite(siteConn, { id: "w1", teamId: "t1" })).not.toThrow();
    expect(() => assertConnectionScopeForWebsite(siteConn, { id: "w2", teamId: "t1" })).toThrow(
      "NOT_FOUND_OR_FORBIDDEN",
    );
  });
  it("an unscoped connection serves nothing", () => {
    expect(() =>
      assertConnectionScopeForWebsite(
        { teamId: null, websiteId: null, ownerType: "ORGANIZATION", ownerId: "org1" },
        { id: "w1", teamId: "t1" },
      ),
    ).toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("legacy polymorphic columns are consulted when typed FKs are null", () => {
    expect(() =>
      assertConnectionScopeForWebsite(
        { teamId: null, websiteId: null, ownerType: "TEAM", ownerId: "t1" },
        { id: "w1", teamId: "t1" },
      ),
    ).not.toThrow();
    expect(() =>
      assertConnectionScopeForWebsite(
        { teamId: null, websiteId: null, ownerType: "WEBSITE", ownerId: "w1" },
        { id: "w1", teamId: null },
      ),
    ).not.toThrow();
  });
});

describe("assertWebsiteAccess", () => {
  it("SUPER_ADMIN can access a website in their org", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    await expect(assertWebsiteAccess(user(), "w1")).resolves.toEqual(website());
  });
  it("foreign-org website is indistinguishable from missing", async () => {
    mocks.websiteFindFirst.mockResolvedValue(null);
    await expect(assertWebsiteAccess(user(), "w1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a team admin of the website's team can access it", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    await expect(assertWebsiteAccess(user({ role: "TEAM_ADMIN" }), "w1")).resolves.toEqual(website());
  });
  it("a plain member of the team cannot access it without an assignment", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false });
    await expect(assertWebsiteAccess(user({ role: "TEAM_MEMBER" }), "w1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("an explicitly assigned user can access it regardless of role", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    mocks.websiteAssignmentFindFirst.mockResolvedValue({ websiteId: "w1", userId: "u1" });
    await expect(assertWebsiteAccess(user({ role: "TEAM_MEMBER" }), "w1")).resolves.toEqual(website());
  });
  it("a TEAM_ADMIN without isAdmin and without assignment is denied even in their team", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false });
    await expect(assertWebsiteAccess(user({ role: "TEAM_ADMIN" }), "w1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
});

describe("assertWebsiteManageAccess", () => {
  it("SUPER_ADMIN can manage a website in their org", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    await expect(assertWebsiteManageAccess(user(), "w1")).resolves.toEqual(website());
  });
  it("foreign-org website throws", async () => {
    mocks.websiteFindFirst.mockResolvedValue(null);
    await expect(assertWebsiteManageAccess(user(), "w1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a team admin of the website's team can manage it", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    await expect(assertWebsiteManageAccess(user({ role: "TEAM_ADMIN" }), "w1")).resolves.toEqual(website());
  });
  it("an assignment alone is NOT enough to manage (view-level only)", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    // Note: manage access never consults websiteAssignment at all.
    await expect(assertWebsiteManageAccess(user({ role: "TEAM_MEMBER" }), "w1")).rejects.toThrow(
      "NOT_FOUND_OR_FORBIDDEN",
    );
    expect(mocks.websiteAssignmentFindFirst).not.toHaveBeenCalled();
  });
});

describe("assertConnectionOwnerAccess", () => {
  it("TEAM owner delegates to team access (SUPER_ADMIN, own org)", async () => {
    mocks.teamFindFirst.mockResolvedValue(team());
    await expect(assertConnectionOwnerAccess(user(), "TEAM", "t1")).resolves.toEqual(team());
  });
  it("TEAM owner in another org throws", async () => {
    mocks.teamFindFirst.mockResolvedValue(null);
    await expect(assertConnectionOwnerAccess(user(), "TEAM", "t1")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("WEBSITE owner delegates to website manage access", async () => {
    mocks.websiteFindFirst.mockResolvedValue(website());
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    await expect(assertConnectionOwnerAccess(user({ role: "TEAM_ADMIN" }), "WEBSITE", "w1")).resolves.toEqual(
      website(),
    );
  });
});

describe("connectionVisibilityWhere", () => {
  it("SUPER_ADMIN sees every connection in the org", async () => {
    await expect(connectionVisibilityWhere(user())).resolves.toEqual({});
    expect(mocks.teamMemberFindMany).not.toHaveBeenCalled();
  });
  it("others see only connections of teams they administer", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }, { teamId: "t2" }]);
    await expect(connectionVisibilityWhere(user({ role: "TEAM_ADMIN" }))).resolves.toEqual({
      OR: [{ teamId: { in: ["t1", "t2"] } }, { website: { teamId: { in: ["t1", "t2"] } } }],
    });
  });
  it("a user administering no team sees nothing", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([]);
    await expect(connectionVisibilityWhere(user({ role: "TEAM_MEMBER" }))).resolves.toEqual({
      OR: [{ teamId: { in: [] } }, { website: { teamId: { in: [] } } }],
    });
  });
});

describe("assertConnectionVisible", () => {
  it("SUPER_ADMIN can see any connection", async () => {
    await expect(assertConnectionVisible(user(), { teamId: "t9", websiteId: null })).resolves.toBeUndefined();
  });
  it("a team admin can see a connection owned by their team", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }]);
    await expect(
      assertConnectionVisible(user({ role: "TEAM_ADMIN" }), { teamId: "t1", websiteId: null }),
    ).resolves.toBeUndefined();
  });
  it("a team admin cannot see a connection owned by another team", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }]);
    await expect(
      assertConnectionVisible(user({ role: "TEAM_ADMIN" }), { teamId: "t2", websiteId: null }),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
  it("a website connection is visible when its website's team is administered", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }]);
    mocks.websiteFindFirst.mockResolvedValue({ teamId: "t1" });
    await expect(
      assertConnectionVisible(user({ role: "TEAM_ADMIN" }), { teamId: null, websiteId: "w1" }),
    ).resolves.toBeUndefined();
  });
  it("a website connection in another team's website is not visible", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }]);
    mocks.websiteFindFirst.mockResolvedValue({ teamId: "t2" });
    await expect(
      assertConnectionVisible(user({ role: "TEAM_ADMIN" }), { teamId: null, websiteId: "w1" }),
    ).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
  });
});

describe("listAccessibleWebsiteIds", () => {
  it("SUPER_ADMIN gets null (all websites in org)", async () => {
    await expect(listAccessibleWebsiteIds(user())).resolves.toBeNull();
  });
  it("a restricted user gets admin-team websites plus assignments, deduplicated", async () => {
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t1" }]);
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    mocks.websiteAssignmentFindMany.mockResolvedValue([{ websiteId: "w2" }, { websiteId: "w3" }]);
    const ids = await listAccessibleWebsiteIds(user({ role: "TEAM_MEMBER" }));
    expect([...(ids ?? [])].sort()).toEqual(["w1", "w2", "w3"]);
  });
  it("a user with no admin teams and no assignments gets an empty list", async () => {
    await expect(listAccessibleWebsiteIds(user({ role: "TEAM_MEMBER" }))).resolves.toEqual([]);
    expect(mocks.websiteFindMany).not.toHaveBeenCalled();
  });
});
