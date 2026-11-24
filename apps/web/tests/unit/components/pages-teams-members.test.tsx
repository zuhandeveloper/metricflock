// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TeamsPage from "@/app/(app)/teams/page";
import MembersPage from "@/app/(app)/members/page";
import MyTeamPage from "@/app/(app)/team/page";
import { memberUser, pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { mockFetch } from "./helpers";

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
    pageMocks.userFindMany.mockResolvedValue(orgUsers);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(TeamsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders teams with counts and admin controls for managers", async () => {
    mockFetch(null);
    const el = await TeamsPage();
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
    const el = await TeamsPage();
    render(el);
    expect(screen.getByText("No teams yet")).toBeInTheDocument();
    expect(screen.getByText("Create your first team above, then add websites to it.")).toBeInTheDocument();
  });

  it("hides the create form from non-managers and lists members read-only", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await TeamsPage();
    render(el);
    expect(screen.queryByLabelText("Team name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rename team")).not.toBeInTheDocument();
    expect(screen.getByText("admin@example.com · SUPER_ADMIN (team admin)")).toBeInTheDocument();
    expect(screen.getByText("member@example.com · TEAM_MEMBER")).toBeInTheDocument();
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
    pageMocks.organizationInviteFindMany.mockResolvedValue(invites);
    pageMocks.organizationFindUnique.mockResolvedValue({ slug: "acme" });
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(MembersPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders members, invites and org admin actions for a super admin", async () => {
    mockFetch(null);
    const el = await MembersPage();
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

  it("shows the no-pending-invites state and hides org actions from members", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    pageMocks.organizationInviteFindMany.mockResolvedValue([]);
    const el = await MembersPage();
    render(el);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pending invites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Organization" })).not.toBeInTheDocument();
    // own row shows a badge, not a role select
    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
    expect(screen.getByText("TEAM_MEMBER")).toBeInTheDocument();
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
