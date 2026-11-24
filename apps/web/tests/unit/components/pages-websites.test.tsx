// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import WebsitesPage from "@/app/(app)/websites/page";
import WebsitePage from "@/app/(app)/websites/[id]/page";
import { memberUser, pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { mockFetch } from "./helpers";

beforeEach(() => {
  resetPageMocks();
  pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
  pageMocks.listAccessibleWebsiteIds.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const teamOptions = [
  { id: "t1", name: "Team One" },
  { id: "t2", name: "Team Two" },
];

describe("WebsitesPage", () => {
  beforeEach(() => {
    pageMocks.teamFindMany.mockResolvedValue(teamOptions);
    pageMocks.websiteCount.mockResolvedValue(2);
    pageMocks.websiteFindMany.mockResolvedValue([
      {
        id: "w1",
        name: "Blog",
        domain: "blog.example",
        status: "ACTIVE",
        team: { name: "Team One" },
        integrations: [{ provider: "GA4", mappingStatus: "MAPPED" }],
      },
      {
        id: "w2",
        name: "Shop",
        domain: "shop.example",
        status: "PENDING_SETUP",
        team: null,
        integrations: [],
      },
    ]);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(WebsitesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("lists websites with teams, status and integrations", async () => {
    const el = await WebsitesPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Websites" })).toBeInTheDocument();
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("GA4:MAPPED")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open →" })[0]).toHaveAttribute("href", "/websites/w1");
    // add-website form is shown for managers
    expect(screen.getByLabelText("Website name")).toBeInTheDocument();
  });

  it("shows the empty state when nothing matches", async () => {
    pageMocks.websiteCount.mockResolvedValue(0);
    pageMocks.websiteFindMany.mockResolvedValue([]);
    const el = await WebsitesPage({ searchParams: Promise.resolve({ q: "zzz" }) });
    render(el);
    expect(screen.getByText("No websites match")).toBeInTheDocument();
    expect(screen.getByText("Add your first website with the form above.")).toBeInTheDocument();
  });

  it("hides the add form from non-managers and changes the empty hint", async () => {
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    pageMocks.websiteCount.mockResolvedValue(0);
    pageMocks.websiteFindMany.mockResolvedValue([]);
    const el = await WebsitesPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.queryByLabelText("Website name")).not.toBeInTheDocument();
    expect(screen.getByText("No websites are visible to you yet.")).toBeInTheDocument();
  });

  it("paginates and keeps filters in page links", async () => {
    pageMocks.websiteCount.mockResolvedValue(120);
    const el = await WebsitesPage({ searchParams: Promise.resolve({ q: "blog", status: "ACTIVE", page: "2" }) });
    render(el);
    expect(screen.getByText("Page 2 of 3 · 120 websites")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Previous" })).toHaveAttribute("href", "/websites?q=blog&status=ACTIVE");
    expect(screen.getByRole("link", { name: "Next →" })).toHaveAttribute(
      "href",
      "/websites?q=blog&status=ACTIVE&page=3",
    );
  });
});

describe("WebsitePage", () => {
  const fullWebsite = {
    id: "w1",
    name: "Blog",
    domain: "blog.example",
    url: "https://blog.example",
    status: "ACTIVE",
    teamId: "t1",
    team: { name: "Team One" },
    integrations: [
      {
        id: "i1",
        provider: "GA4",
        externalId: "123",
        resourceName: "Blog GA4",
        mappingStatus: "MAPPED",
        isPrimary: true,
      },
    ],
    transfers: [{ id: "tr1", status: "COMPLETED", initiatedAt: new Date("2026-11-20T10:00:00.000Z"), toTeamId: "t2" }],
    assignments: [{ user: { id: "u2", email: "member@example.com" } }],
  };

  beforeEach(() => {
    pageMocks.assertWebsiteAccess.mockResolvedValue({ id: "w1" });
    pageMocks.websiteFindUnique.mockResolvedValue(fullWebsite);
    pageMocks.teamFindMany.mockResolvedValue(teamOptions);
    pageMocks.userFindMany.mockResolvedValue([
      { id: "u1", email: "admin@example.com", role: "SUPER_ADMIN" },
      { id: "u2", email: "member@example.com", role: "TEAM_MEMBER" },
    ]);
  });

  it("redirects to /login when there is no session and 404s for inaccessible websites", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(
      WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT:/login");
    pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
    pageMocks.assertWebsiteAccess.mockResolvedValue(null);
    await expect(
      WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    pageMocks.assertWebsiteAccess.mockRejectedValue(new Error("denied"));
    await expect(
      WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the website, integrations, analytics stub and management forms", async () => {
    mockFetch(null);
    const el = await WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Blog" })).toBeInTheDocument();
    expect(screen.getByText(/blog.example · https:\/\/blog.example · Team: Team One/)).toBeInTheDocument();
    expect(screen.getByText(/GA4 — 123 \(Blog GA4\) · MAPPED · primary/)).toBeInTheDocument();
    expect(screen.getByTestId("website-analytics-stub")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edit website" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Assigned members" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transfer ownership" })).toBeInTheDocument();
    expect(screen.getByText(/COMPLETED · 2026-11-20T10:00:00.000Z · to team t2/)).toBeInTheDocument();
  });

  it("shows empty states for no integrations and no transfers", async () => {
    mockFetch(null);
    pageMocks.websiteFindUnique.mockResolvedValue({ ...fullWebsite, integrations: [], transfers: [] });
    const el = await WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText(/No properties mapped yet/)).toBeInTheDocument();
    expect(screen.getByText("No transfers recorded.")).toBeInTheDocument();
  });

  it("hides management cards from members without permissions", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    const el = await WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.queryByRole("heading", { name: "Edit website" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Assigned members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Transfer ownership" })).not.toBeInTheDocument();
  });

  it("lets the delete button work from the page", async () => {
    mockFetch(null);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const el = await WebsitePage({ params: Promise.resolve({ id: "w1" }), searchParams: Promise.resolve({}) });
    render(el);
    fireEvent.click(screen.getByRole("button", { name: "Delete website" }));
    await screen.findByText("Delete website");
    expect(fetch).toHaveBeenCalledWith("/api/websites/w1", expect.objectContaining({ method: "DELETE" }));
  });
});
