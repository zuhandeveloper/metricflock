// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TeamsPage from "@/app/(app)/teams/page";
import MembersPage from "@/app/(app)/members/page";
import MyTeamPage from "@/app/(app)/team/page";
import { memberUser, pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { mockFetch } from "./helpers";

// A-SEC-10: page-state.ts is shared (and frozen for this fix), so the
// team-admin fixture lives here — TEAM_ADMIN holds member.manage and
// team.view, so both directory pages must stay fully visible to them.
const teamAdminUser = {
  id: "u3",
  organizationId: "org1",
  role: "TEAM_ADMIN",
  email: "teamadmin@example.com",
  name: "Team Admin",
  twoFactorEnabled: false,
};

beforeEach(() => {
  resetPageMocks();
  pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TeamsPage", () => {
  const teams = [
    {
      id: "t1",
      name: "Alpha",
      _count: { members: 2, websites: 3 },
      members: [
        { id: "tm1", userId: "u1", user: { id: "u1", email: "admin@example.com", role: "SUPER_ADMIN" }, isAdmin: true },
        {
          id: "tm2",
          userId: "u2",
          user: { id: "u2", email: "member@example.com", role: "TEAM_MEMBER" },
          isAdmin: false,
        },
      ],
    },
  ];
  const orgUsers = [
    { id: "u1", email: "admin@example.com", role: "SUPER_ADMIN" },
    { id: "u2", email: "member@example.com", role: "TEAM_MEMBER" },
  ];

  beforeEach(() => {
    pageMocks.teamFindMany.mockResolvedValue(teams);
    pageMocks.teamCount.mockResolvedValue(teams.length);
    pageMocks.userFindMany.mockResolvedValue(orgUsers);
    pageMocks.userCount.mockResolvedValue(orgUsers.length);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(TeamsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders teams with counts and admin controls for managers", async () => {
    mockFetch(null);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Teams" })).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("2 members · 3 websites")).toBeInTheDocument();
    expect(screen.getByLabelText("Team name")).toBeInTheDocument(); // create form
    expect(screen.getByLabelText("Rename team")).toBeInTheDocument(); // admin controls
    expect(screen.getByText(/admin@example.com · SUPER_ADMIN \(team admin\)/)).toBeInTheDocument();
  });

  it("shows the empty state when there are no teams", async () => {
    mockFetch(null);
    pageMocks.teamFindMany.mockResolvedValue([]);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("No teams yet")).toBeInTheDocument();
    expect(screen.getByText("Create your first team above, then add websites to it.")).toBeInTheDocument();
  });

  it("gates the directory for team members: no teams, no member emails, no queries", async () => {
    // A-SEC-10: TEAM_MEMBER has no team.view (GET /api/teams requires
    // it), so the page renders the gated state and never queries the
    // team directory at all.
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("Admins only")).toBeInTheDocument();
    expect(screen.getByText("Viewing teams is restricted to organization and team admins.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Team name")).not.toBeInTheDocument();
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
    expect(pageMocks.teamFindMany).not.toHaveBeenCalled();
    expect(pageMocks.userFindMany).not.toHaveBeenCalled();
  });

  it("renders teams and admin controls for a team admin", async () => {
    // The mock returns the fixture regardless of the where clause; the
    // A-SEC-11 scoping itself is asserted in the test below.
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(teamAdminUser);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Teams" })).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Team name")).toBeInTheDocument(); // create form
    expect(screen.getByLabelText("Rename team")).toBeInTheDocument(); // admin controls
    expect(screen.getByText(/admin@example.com · SUPER_ADMIN \(team admin\)/)).toBeInTheDocument();
  });

  it("A-SEC-11: scopes the directory for a team admin to teams they administer", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(teamAdminUser);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(pageMocks.teamFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org1",
          members: { some: { userId: "u3", isAdmin: true } },
        },
      }),
    );
  });

  it("A-SEC-11: super admin sees every team (no membership filter)", async () => {
    mockFetch(null);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(pageMocks.teamFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org1" } }));
  });

  it("A-FE-15: paginates teams past the page size (pager + total appear)", async () => {
    mockFetch(null);
    pageMocks.teamCount.mockResolvedValue(75);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("navigation", { name: "Teams pagination" })).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2 · 75 teams")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute("href", "/teams?page=2");
    expect(pageMocks.teamFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });

  it("A-FE-15: page 2 skips the first page of teams", async () => {
    mockFetch(null);
    pageMocks.teamCount.mockResolvedValue(75);
    const el = await TeamsPage({ searchParams: Promise.resolve({ page: "2" }) });
    render(el);
    expect(screen.getByText("Page 2 of 2 · 75 teams")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", "/teams");
    expect(pageMocks.teamFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
  });

  it("A-FE-15: no pager at or below the page size", async () => {
    mockFetch(null);
    pageMocks.teamCount.mockResolvedValue(1);
    const el = await TeamsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.queryByRole("navigation", { name: "Teams pagination" })).not.toBeInTheDocument();
  });
});

describe("MembersPage", () => {
  const members = [
    {
      id: "u1",
      name: "Admin",
      email: "admin@example.com",
      role: "SUPER_ADMIN",
      createdAt: new Date("2026-11-01T10:00:00.000Z"),
      emailVerified: true,
    },
    {
      id: "u2",
      name: null,
      email: "member@example.com",
      role: "TEAM_MEMBER",
      createdAt: new Date("2026-11-02T10:00:00.000Z"),
      emailVerified: false,
    },
  ];
  const invites = [
    { id: "inv1", email: "pending@example.com", role: "TEAM_MEMBER", expiresAt: new Date("2026-12-01T10:00:00.000Z") },
  ];

  beforeEach(() => {
    pageMocks.userFindMany.mockResolvedValue(members);
    pageMocks.userCount.mockResolvedValue(members.length);
    pageMocks.organizationInviteFindMany.mockResolvedValue(invites);
    pageMocks.organizationFindUnique.mockResolvedValue({ slug: "acme" });
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(MembersPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders members, invites and org admin actions for a super admin", async () => {
    mockFetch(null);
    const el = await MembersPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByText(/admin@example.com \(you\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument(); // invite form
    expect(screen.getByText(/pending@example.com · TEAM_MEMBER · expires 2026-12-01/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Organization" })).toBeInTheDocument();
    expect(screen.getByText("Download export (JSON)")).toBeInTheDocument();
    // role select + delete for the other member only (invite form has its own Role select)
    expect(screen.getAllByLabelText("Role")).toHaveLength(2);
  });

  it("gates the directory for team members: no members, no invites, no queries", async () => {
    // A-SEC-10: TEAM_MEMBER has no member.manage, so the page renders
    // the gated state and never queries members or invites at all.
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await MembersPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("Admins only")).toBeInTheDocument();
    expect(
      screen.getByText("Viewing the member directory is restricted to organization and team admins."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pending invites" })).not.toBeInTheDocument();
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText(/pending@example.com/)).not.toBeInTheDocument();
    expect(pageMocks.userFindMany).not.toHaveBeenCalled();
    expect(pageMocks.organizationInviteFindMany).not.toHaveBeenCalled();
    expect(pageMocks.organizationFindUnique).not.toHaveBeenCalled();
  });

  it("renders members and invites for a team admin (no org actions)", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(teamAdminUser);
    const el = await MembersPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByText(/admin@example.com/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument(); // invite form
    expect(screen.getByText(/pending@example.com · TEAM_MEMBER · expires 2026-12-01/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Organization" })).not.toBeInTheDocument(); // super admin only
  });

  it("A-FE-15: paginates members past the page size (pager + total appear)", async () => {
    mockFetch(null);
    pageMocks.userCount.mockResolvedValue(120);
    const el = await MembersPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("navigation", { name: "Members pagination" })).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3 · 120 members")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute("href", "/members?page=2");
    expect(pageMocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 50 }));
  });

  it("A-FE-15: page 2 skips the first page of members", async () => {
    mockFetch(null);
    pageMocks.userCount.mockResolvedValue(120);
    const el = await MembersPage({ searchParams: Promise.resolve({ page: "2" }) });
    render(el);
    expect(screen.getByText("Page 2 of 3 · 120 members")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", "/members");
    expect(pageMocks.userFindMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 50 }));
  });

  it("A-FE-15: no pager at or below the page size", async () => {
    mockFetch(null);
    pageMocks.userCount.mockResolvedValue(2);
    const el = await MembersPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.queryByRole("navigation", { name: "Members pagination" })).not.toBeInTheDocument();
  });
});

describe("MyTeamPage", () => {
  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(MyTeamPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("shows the empty state when the user is in no team", async () => {
    pageMocks.teamMemberFindMany.mockResolvedValue([]);
    const el = await MyTeamPage();
    render(el);
    expect(screen.getByText("You are not in a team yet")).toBeInTheDocument();
  });

  it("lists the user's teams with members and websites", async () => {
    pageMocks.teamMemberFindMany.mockResolvedValue([
      {
        id: "tm1",
        team: {
          name: "Alpha",
          members: [{ user: { email: "admin@example.com" } }, { user: { email: "member@example.com" } }],
          websites: [
            { id: "w1", name: "Blog", domain: "blog.example", status: "ACTIVE" },
            { id: "w2", name: "Shop", domain: "shop.example", status: "DISCONNECTED" },
          ],
        },
      },
    ]);
    const el = await MyTeamPage();
    render(el);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("2 members · 2 websites")).toBeInTheDocument();
    expect(screen.getByText("Blog (blog.example) — ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("Shop (shop.example) — DISCONNECTED")).toBeInTheDocument();
  });
});
