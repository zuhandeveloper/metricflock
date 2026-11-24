// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import InsightsPage from "@/app/(app)/insights/page";
import IntegrationsPage from "@/app/(app)/integrations/page";
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

describe("InsightsPage", () => {
  const insights = {
    range: { startDate: "2026-10-26", endDate: "2026-11-23" },
    summary: {
      totalEarnings: 123.45,
      blendedPageRpm: 8.5,
      earningsPerThousandSessions: 12.34,
      strikingDistanceQueries: 2,
      lowCtrQueries: 1,
    },
    websites: [
      {
        websiteId: "w1",
        name: "Blog",
        domain: "blog.example",
        seo: {
          truncated: true,
          strikingDistance: [{ query: "best blog", position: 7.5, impressions: 1000, ctr: 0.02 }],
          lowCtr: [{ query: "old post", impressions: 5000, ctr: 0.01 }],
          topQueries: [{ query: "top query", clicks: 42 }],
        },
        revenue: {
          totalEarnings: 100,
          avgDailyEarnings: 3.57,
          bestDay: { date: "2026-11-20", earnings: 9.99 },
          trendPercent: 12.4,
        },
        channels: [
          { channel: "Organic Search", sharePercent: 60.4 },
          { channel: "Direct", sharePercent: 39.6 },
        ],
      },
    ],
    unavailableCount: 1,
  };

  beforeEach(() => {
    pageMocks.loadInsights.mockResolvedValue(insights);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(InsightsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders summary cards, revenue, channels and SEO tables", async () => {
    const el = await InsightsPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Insights" })).toBeInTheDocument();
    expect(screen.getByText(/Last 28 days \(2026-10-26 to 2026-11-23\)/)).toBeInTheDocument();
    expect(screen.getByText(/1 website\(s\) have no snapshot yet/)).toBeInTheDocument();
    expect(screen.getByText("123.45")).toBeInTheDocument();
    expect(screen.getByText("8.50")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // 2 striking + 1 low-CTR
    expect(screen.getByText("Search Console rows truncated")).toBeInTheDocument();
    expect(screen.getByText(/best day 2026-11-20 \(9.99\)/)).toBeInTheDocument();
    expect(screen.getByText(/trend \+12%/)).toBeInTheDocument();
    expect(screen.getByText("Channels: Organic Search 60% · Direct 40%")).toBeInTheDocument();
    expect(screen.getByText("best blog")).toBeInTheDocument();
    expect(screen.getByText("7.5")).toBeInTheDocument();
    expect(screen.getByText("old post (5,000 impr., 1.0%)")).toBeInTheDocument();
    expect(screen.getByText(/Top queries: top query \(42 clicks\)/)).toBeInTheDocument();
  });

  it("shows the empty state when no website has insights", async () => {
    pageMocks.loadInsights.mockResolvedValue({ ...insights, websites: [], unavailableCount: 0 });
    const el = await InsightsPage();
    render(el);
    expect(screen.getByText("No insights yet")).toBeInTheDocument();
    expect(screen.queryByText(/website\(s\) have no snapshot yet/)).not.toBeInTheDocument();
  });

  it("renders null totals as dashes", async () => {
    pageMocks.loadInsights.mockResolvedValue({
      ...insights,
      summary: {
        totalEarnings: null,
        blendedPageRpm: null,
        earningsPerThousandSessions: null,
        strikingDistanceQueries: 0,
        lowCtrQueries: 0,
      },
      websites: [
        {
          websiteId: "w1",
          name: "Blog",
          domain: "blog.example",
          seo: null,
          revenue: null,
          channels: [],
        },
      ],
    });
    const el = await InsightsPage();
    render(el);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("0")).toBeInTheDocument(); // SEO opportunities
  });
});

describe("IntegrationsPage", () => {
  const connection = {
    id: "c1",
    googleAccountEmail: "g@example.com",
    status: "ACTIVE",
    ownerType: "TEAM",
    ownerId: "t1",
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    lastSuccessfulAuthAt: new Date("2026-11-22T10:00:00.000Z"),
    lastUsedAt: new Date("2026-11-23T09:00:00.000Z"),
    health: [{ provider: "GA4", status: "ok" }],
    properties: [
      {
        id: "p1",
        propertyId: "123",
        displayName: "Blog GA4",
        integrations: [{ website: { name: "Blog" } }],
      },
    ],
    searchConsoleProps: [{ id: "s1", siteUrl: "sc-domain:blog.example", integrations: [] }],
    adsenseAccounts: [{ id: "a1", accountId: "pub-1", displayName: null, integrations: [] }],
    adManagerNetworks: [{ id: "n1", networkCode: "123456", displayName: "Main network", integrations: [] }],
  };

  beforeEach(() => {
    pageMocks.googleConnectionFindMany.mockResolvedValue([connection]);
    pageMocks.teamFindMany.mockResolvedValue([{ id: "t1", name: "Team One" }]);
    pageMocks.websiteFindMany.mockResolvedValue([{ id: "w1", name: "Blog" }]);
    pageMocks.providersMissingScopes.mockReturnValue([]);
    pageMocks.adManagerEnabled.mockReturnValue(true);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(IntegrationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders connections, properties and map forms", async () => {
    mockFetch(null);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.getByText("g@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Owner: TEAM Team One/)).toBeInTheDocument();
    expect(screen.getByText("Health: GA4:ok")).toBeInTheDocument();
    expect(screen.getByText("Connect team: Team One")).toBeInTheDocument();
    expect(screen.getByText("Connect website: Blog")).toBeInTheDocument();
    expect(screen.getByText(/GA4 · Blog GA4/)).toBeInTheDocument();
    expect(screen.getByText("Mapped to: Blog")).toBeInTheDocument();
    expect(screen.getByText("Search Console · sc-domain:blog.example")).toBeInTheDocument();
    expect(screen.getByText(/AdSense · pub-1/)).toBeInTheDocument();
    expect(screen.getByText(/Ad Manager \(beta\) · Main network/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discover properties" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("shows the oauth result banner with hints", async () => {
    mockFetch(null);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({ oauth: "no_refresh_token" }) });
    render(el);
    expect(screen.getByText(/OAuth result:/)).toBeInTheDocument();
    expect(screen.getByText(/Google did not return a refresh token/)).toBeInTheDocument();
  });

  it("shows the connected banner for a successful oauth", async () => {
    mockFetch(null);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({ oauth: "connected" }) });
    render(el);
    expect(screen.getByText(/account connected. Discover properties/)).toBeInTheDocument();
  });

  it("warns about missing scopes with a reconnect link for managers", async () => {
    mockFetch(null);
    pageMocks.providersMissingScopes.mockReturnValue(["AdSense"]);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText(/missing required permissions for AdSense/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reconnect now" })).toHaveAttribute(
      "href",
      "/api/google/oauth/connect?ownerType=TEAM&ownerId=t1",
    );
  });

  it("shows the website owner name for website-level connections", async () => {
    mockFetch(null);
    pageMocks.googleConnectionFindMany.mockResolvedValue([
      {
        ...connection,
        ownerType: "WEBSITE",
        ownerId: "w1",
        properties: [],
        searchConsoleProps: [],
        adsenseAccounts: [],
        adManagerNetworks: [],
      },
    ]);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText(/Owner: WEBSITE Blog/)).toBeInTheDocument();
    expect(screen.getByText("No properties discovered yet — use “Discover properties”.")).toBeInTheDocument();
  });

  it("shows the empty states for no connections and no teams/websites", async () => {
    mockFetch(null);
    pageMocks.googleConnectionFindMany.mockResolvedValue([]);
    pageMocks.teamFindMany.mockResolvedValue([]);
    pageMocks.websiteFindMany.mockResolvedValue([]);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.getByText("No Google accounts connected")).toBeInTheDocument();
    expect(screen.getByText(/Create a team first/)).toBeInTheDocument();
  });

  it("shows the no-properties hint and hides management buttons from non-managers", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    pageMocks.googleConnectionFindMany.mockResolvedValue([
      { ...connection, properties: [], searchConsoleProps: [], adsenseAccounts: [], adManagerNetworks: [] },
    ]);
    const el = await IntegrationsPage({ searchParams: Promise.resolve({}) });
    render(el);
    expect(screen.queryByRole("button", { name: "Discover properties" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByText(/No properties discovered yet/)).not.toBeInTheDocument();
  });
});
