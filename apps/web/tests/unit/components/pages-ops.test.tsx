// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import HealthPage from "@/app/(app)/health/page";
import SyncJobsPage from "@/app/(app)/sync/page";
import TransfersPage from "@/app/(app)/transfers/page";
import AuditPage from "@/app/(app)/audit/page";
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

describe("HealthPage", () => {
  beforeEach(() => {
    pageMocks.loadHealthOverview.mockResolvedValue({
      summary: { healthy: 2, error: 1, stale: 1, withoutRecord: 0 },
      rows: [
        {
          websiteId: "w1",
          websiteName: "Blog",
          domain: "blog.example",
          provider: "GA4",
          state: "healthy",
          lastSuccessAt: "2026-11-23T09:00:00.000Z",
          checkedAt: "2026-11-23T10:00:00.000Z",
          lastError: null,
        },
        {
          websiteId: "w2",
          websiteName: "Shop",
          domain: "shop.example",
          provider: "ADSENSE",
          state: "error",
          lastSuccessAt: null,
          checkedAt: "2026-11-23T10:00:00.000Z",
          lastError: "api_not_enabled",
        },
      ],
      total: 2,
      pageCount: 1,
    });
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(HealthPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders the summary and rows with states and errors", async () => {
    const el = await HealthPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Integration health" })).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("api_not_enabled")).toBeInTheDocument();
    expect(screen.getByText("2026-11-23 09:00")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2); // no last success for the error row, no error for the healthy row
    expect(screen.getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/websites/w1");
  });

  it("shows the empty state when there are no records", async () => {
    pageMocks.loadHealthOverview.mockResolvedValue({
      summary: { healthy: 0, error: 0, stale: 0, withoutRecord: 0 },
      rows: [],
      total: 0,
      pageCount: 1,
    });
    const el = await HealthPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("No health records yet")).toBeInTheDocument();
  });

  it("paginates when there is more than one page", async () => {
    pageMocks.loadHealthOverview.mockResolvedValue({
      summary: { healthy: 0, error: 0, stale: 0, withoutRecord: 0 },
      rows: [],
      total: 60,
      pageCount: 3,
    });
    const el = await HealthPage({ searchParams: Promise.resolve({ page: "2" }) });
    render(el);
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/health?page=1");
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/health?page=3");
    expect(pageMocks.loadHealthOverview).toHaveBeenCalledWith(expect.anything(), 2);
  });
});

describe("SyncJobsPage", () => {
  beforeEach(() => {
    pageMocks.analyticsSyncJobFindMany.mockImplementation(
      async (args: { where?: { status?: string | { in: string[] } } }) => {
        if (args.where?.status === "FAILED") {
          return [
            {
              id: "j1",
              websiteId: "w1",
              website: { name: "Blog", domain: "blog.example" },
              type: "ga4-historical-sync",
              attempts: 3,
              lastError: "quota_exceeded",
              updatedAt: new Date("2026-11-23T10:00:00.000Z"),
            },
          ];
        }
        return [
          {
            id: "j2",
            websiteId: "w1",
            website: null,
            type: "search-console-sync",
            status: "RUNNING",
            updatedAt: new Date("2026-11-23T10:05:00.000Z"),
          },
        ];
      },
    );
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(SyncJobsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("shows the super-admin-only state for members", async () => {
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await SyncJobsPage();
    render(el);
    expect(screen.getByText("Super Admin only")).toBeInTheDocument();
    expect(pageMocks.analyticsSyncJobFindMany).not.toHaveBeenCalled();
  });

  it("lists failed jobs with requeue buttons and recent jobs", async () => {
    mockFetch(null);
    const el = await SyncJobsPage();
    render(el);
    expect(screen.getByText("Failed jobs (dead-letter)")).toBeInTheDocument();
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("ga4-historical-sync")).toBeInTheDocument();
    expect(screen.getByText("quota_exceeded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requeue" })).toBeInTheDocument();
    expect(screen.getByText("w1")).toBeInTheDocument(); // website null falls back to websiteId
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
  });

  it("shows empty states for both lists", async () => {
    mockFetch(null);
    pageMocks.analyticsSyncJobFindMany.mockResolvedValue([]);
    const el = await SyncJobsPage();
    render(el);
    expect(screen.getByText("No failed jobs.")).toBeInTheDocument();
    expect(screen.getByText(/No sync jobs yet/)).toBeInTheDocument();
  });
});

describe("TransfersPage", () => {
  const transfers = [
    {
      id: "tr1",
      website: { name: "Blog", domain: "blog.example" },
      fromTeam: { name: "Alpha" },
      toTeam: { name: "Beta" },
      toTeamId: "t2",
      initiatedBy: { email: "admin@example.com" },
      initiatedById: "u1",
      status: "PENDING_ACCEPTANCE",
      initiatedAt: new Date("2026-11-20T10:00:00.000Z"),
    },
    {
      id: "tr2",
      website: { name: "Shop", domain: "shop.example" },
      fromTeam: null,
      toTeam: { name: "Gamma" },
      toTeamId: "t3",
      initiatedBy: { email: "other@example.com" },
      initiatedById: "u9",
      status: "COMPLETED",
      initiatedAt: new Date("2026-11-18T10:00:00.000Z"),
    },
  ];

  beforeEach(() => {
    pageMocks.websiteTransferFindMany.mockResolvedValue(transfers);
    pageMocks.teamMemberFindMany.mockResolvedValue([{ teamId: "t2" }]);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(TransfersPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders transfers with actions for the destination admin", async () => {
    mockFetch(null);
    const el = await TransfersPage();
    render(el);
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("Alpha → Beta")).toBeInTheDocument();
    expect(screen.getByText("— → Gamma")).toBeInTheDocument();
    expect(screen.getByText("2026-11-20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    // completed transfer renders no actions
    expect(screen.getAllByText("COMPLETED")).toHaveLength(1);
  });

  it("shows the empty state when there are no transfers", async () => {
    mockFetch(null);
    pageMocks.websiteTransferFindMany.mockResolvedValue([]);
    pageMocks.teamMemberFindMany.mockResolvedValue([]);
    const el = await TransfersPage();
    render(el);
    expect(screen.getByText("No transfers yet")).toBeInTheDocument();
  });
});

describe("AuditPage", () => {
  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(AuditPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("denies non-super-admins without querying", async () => {
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await AuditPage();
    render(el);
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
    expect(pageMocks.auditLogFindMany).not.toHaveBeenCalled();
  });

  it("lists audit entries with actor fallback to system", async () => {
    pageMocks.auditLogFindMany.mockResolvedValue([
      {
        id: "a1",
        createdAt: new Date("2026-11-23T10:00:00.000Z"),
        actor: { email: "admin@example.com" },
        action: "website.delete",
        entityType: "Website",
        entityId: "w1",
      },
      {
        id: "a2",
        createdAt: new Date("2026-11-23T09:00:00.000Z"),
        actor: null,
        action: "sync.completed",
        entityType: null,
        entityId: null,
      },
    ]);
    const el = await AuditPage();
    render(el);
    expect(screen.getByText("website.delete")).toBeInTheDocument();
    expect(screen.getByText("Website w1")).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the empty state when there are no entries", async () => {
    pageMocks.auditLogFindMany.mockResolvedValue([]);
    const el = await AuditPage();
    render(el);
    expect(screen.getByText("No audit entries yet")).toBeInTheDocument();
  });
});
