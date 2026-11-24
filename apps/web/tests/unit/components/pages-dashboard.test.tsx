// @vitest-environment jsdom
import "./page-mocks";
import { memberUser, pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardPage from "@/app/(app)/dashboard/page";

beforeEach(() => {
  resetPageMocks();
  pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
  pageMocks.listAccessibleWebsiteIds.mockResolvedValue(null);
  pageMocks.websiteCount.mockImplementation(async (args: { where?: { integrations?: unknown } }) =>
    args.where?.integrations ? 1 : 2,
  );
  pageMocks.websiteFindMany.mockResolvedValue([
    {
      id: "w1",
      name: "Blog",
      domain: "blog.example",
      status: "ACTIVE",
      team: { name: "Team One" },
      createdAt: new Date("2026-11-20T10:00:00.000Z"),
    },
    {
      id: "w2",
      name: "Shop",
      domain: "shop.example",
      status: "PENDING_SETUP",
      team: null,
      createdAt: new Date("2026-11-19T10:00:00.000Z"),
    },
  ]);
  pageMocks.teamCount.mockResolvedValue(1);
  pageMocks.userCount.mockResolvedValue(3);
  pageMocks.googleConnectionCount.mockImplementation(async (args: { where?: { status?: string } }) =>
    args.where?.status === "ACTIVE" ? 1 : 2,
  );
  pageMocks.googleConnectionFindMany.mockResolvedValue([
    { id: "c1", googleAccountEmail: "g@example.com", status: "ACTIVE", ownerType: "TEAM" },
    { id: "c2", googleAccountEmail: "h@example.com", status: "NEEDS_REAUTH", ownerType: "WEBSITE" },
  ]);
  pageMocks.websiteIntegrationGroupBy.mockResolvedValue([
    { provider: "GA4", _count: { _all: 2 } },
    { provider: "SEARCH_CONSOLE", _count: { _all: 1 } },
  ]);
  pageMocks.analyticsSyncJobGroupBy.mockResolvedValue([
    { websiteId: "w1", _max: { updatedAt: new Date("2026-11-23T09:30:00.000Z") } },
  ]);
  pageMocks.loadPortfolio.mockImplementation(async (_user: unknown, opts: { provider: string }) => {
    if (opts.provider === "GA4") {
      return {
        totals: { sessions: 1000, activeUsers: 800, screenPageViews: 2500 },
        websites: [
          {
            websiteId: "w1",
            name: "Blog",
            domain: "blog.example",
            payload: { summary: { sessions: 700 } },
            stale: false,
            snapshotUpdatedAt: "2026-11-23T09:00:00.000Z",
          },
          {
            websiteId: "w2",
            name: "Shop",
            domain: "shop.example",
            payload: { summary: { sessions: 300 } },
            stale: true,
            snapshotUpdatedAt: "2026-11-20T09:00:00.000Z",
          },
        ],
      };
    }
    if (opts.provider === "SEARCH_CONSOLE") {
      return { totals: { clicks: 120, impressions: 5000 }, websites: [] };
    }
    return { totals: { ESTIMATED_EARNINGS: 45.67 }, websites: [] };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderDashboard(searchParams: Record<string, string> = {}) {
  const el = await DashboardPage({ searchParams: Promise.resolve(searchParams) });
  render(el);
}

describe("DashboardPage", () => {
  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(DashboardPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders metrics, portfolio totals, websites and connections", async () => {
    await renderDashboard();
    expect(screen.getByRole("heading", { name: "Super Admin Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as admin@example.com \(SUPER_ADMIN\)/)).toBeInTheDocument();
    expect(screen.getAllByText("Blog")).toHaveLength(2); // websites table + top-by-sessions
    expect(screen.getAllByText("blog.example")).toHaveLength(2);
    expect(screen.getAllByText("Shop")).toHaveLength(2);
    // metric cards
    expect(screen.getByText("Total websites")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument(); // GA4 sessions
    expect(screen.getByText("$45.67")).toBeInTheDocument(); // AdSense earnings
    expect(screen.getByText("5,000 impressions")).toBeInTheDocument(); // SC impressions sub
    // last sync for w1, never for w2
    expect(screen.getByText("2026-11-23 09:30")).toBeInTheDocument();
    expect(screen.getByText("never")).toBeInTheDocument();
    // top websites table + stale badge
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/websites/w1");
    // connections
    expect(screen.getByText("g@example.com")).toBeInTheDocument();
    expect(screen.getByText("h@example.com")).toBeInTheDocument();
  });

  it("shows the get-started card when there are no teams", async () => {
    pageMocks.teamCount.mockResolvedValue(0);
    await renderDashboard();
    expect(screen.getByText("Get started")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a team" })).toHaveAttribute("href", "/teams");
  });

  it("shows the no-websites and no-snapshots empty states", async () => {
    pageMocks.websiteCount.mockResolvedValue(0);
    pageMocks.websiteFindMany.mockResolvedValue([]);
    pageMocks.googleConnectionCount.mockResolvedValue(0);
    pageMocks.googleConnectionFindMany.mockResolvedValue([]);
    pageMocks.loadPortfolio.mockResolvedValue({ totals: {}, websites: [] });
    await renderDashboard();
    expect(screen.getByText("No websites yet")).toBeInTheDocument();
    expect(screen.getByText("No snapshots yet")).toBeInTheDocument();
    expect(screen.getByText("No Google accounts connected")).toBeInTheDocument();
  });

  it("paginates the website table and keeps the range in page links", async () => {
    pageMocks.websiteCount.mockImplementation(async (args: { where?: { integrations?: unknown } }) =>
      args.where?.integrations ? 1 : 120,
    );
    await renderDashboard({ range: "7d", page: "2" });
    expect(screen.getByText("Page 2 of 3 · 120 websites")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", "/dashboard?range=7d");
    expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute("href", "/dashboard?range=7d&page=3");
    expect(screen.getByText(/Range: 7d/)).toBeInTheDocument();
  });

  it("shows the plain Dashboard title for non-super-admins", async () => {
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    await renderDashboard();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Super Admin Dashboard" })).not.toBeInTheDocument();
  });

  it("notes when connections exceed the shown cap", async () => {
    pageMocks.googleConnectionCount.mockImplementation(async (args: { where?: { status?: string } }) =>
      args.where?.status === "ACTIVE" ? 1 : 60,
    );
    await renderDashboard();
    expect(screen.getByText(/Showing the 50 most recent of 60 connections/)).toBeInTheDocument();
  });
});
