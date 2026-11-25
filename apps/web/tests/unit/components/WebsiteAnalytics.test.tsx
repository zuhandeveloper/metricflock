// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { mockFetchRoutes } from "./helpers";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAnalytics() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WebsiteAnalytics websiteId="w1" range="28d" />
    </QueryClientProvider>,
  );
}

const okRoutes = {
  "/api/analytics/realtime": {
    body: {
      status: "ok",
      dataSource: "live",
      freshness: "live",
      lastSyncedAt: "2026-11-23T10:00:00.000Z",
      data: { activeUsers: 5, eventCount: 12, byCountry: [{ name: "US", activeUsers: 3 }] },
    },
  },
  "/api/analytics/overview": {
    body: {
      status: "ok",
      dataSource: "snapshot",
      freshness: "fresh",
      lastSyncedAt: "2026-11-23T09:00:00.000Z",
      data: {
        summary: { totalUsers: 101, sessions: 50, engagementRate: 0.5, averageEngagementTime: 90, bounceRate: 0.2 },
        rows: [{ dimension0: "2026-11-20", activeUsers: 10, screenPageViews: 20 }],
        sampling: { sampled: true, samplesReadCount: 1000, samplingSpaceSize: 5000, subjectToThresholding: true },
      },
    },
  },
  "/api/analytics/pages": {
    body: { status: "ok", data: { rows: [{ dimension0: "/home", screenPageViews: 100 }] } },
  },
  "/api/analytics/search-console": {
    body: {
      status: "ok",
      data: { totals: { clicks: 10, impressions: 100, avgCtr: 0.1, avgPosition: 5.5 } },
    },
  },
  "/api/analytics/adsense": {
    body: {
      status: "ok",
      data: { totalsByMetric: { ESTIMATED_EARNINGS: 12.34, PAGE_VIEWS: 1000 }, note: "Estimated", rows: [{}, {}] },
    },
  },
};

describe("WebsiteAnalytics", () => {
  it("shows loading states first, then renders all five sections with data", async () => {
    mockFetchRoutes(okRoutes);
    renderAnalytics();
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Active users")).toBeInTheDocument());
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("US: 3")).toBeInTheDocument();
    // overview summary formatting: percent, engagement time, plain numbers
    expect(screen.getByText("50.0%")).toBeInTheDocument(); // engagementRate
    expect(screen.getByText("1m 30s")).toBeInTheDocument(); // averageEngagementTime
    expect(screen.getByText("101")).toBeInTheDocument(); // totalUsers
    expect(screen.getByText(/Sampled data: GA4 read 1,000 of 5,000 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/withheld by GA4 thresholding/)).toBeInTheDocument();
    expect(
      screen.getByText("Source: snapshot · Freshness: fresh · Last synced: 2026-11-23T09:00:00.000Z"),
    ).toBeInTheDocument();
    // search console + adsense
    expect(screen.getByText("10.0%")).toBeInTheDocument(); // avgCtr
    expect(screen.getByText("12.34")).toBeInTheDocument(); // ESTIMATED_EARNINGS
    expect(screen.getByText(/Estimated · 2 daily rows returned/)).toBeInTheDocument();
    // charts render their labelled containers
    expect(screen.getByRole("img", { name: /Line chart of daily active users/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Bar chart of top pages/ })).toBeInTheDocument();
    const csv = screen.getByRole("link", { name: "Download pages CSV" });
    expect(csv).toHaveAttribute("href", "/api/analytics/pages?websiteId=w1&range=28d&format=csv");
  });

  it("shows error states with hints and a working Retry button", async () => {
    const fetchMock = mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/realtime": { body: { error: "api_not_enabled" }, ok: false, status: 502 },
      "/api/analytics/overview": { body: { error: "unauthorized" }, ok: false, status: 401 },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByText(/Couldn't load this data \(api_not_enabled\)/)).toBeInTheDocument());
    expect(screen.getByText(/enable this Google API in Google Cloud Console/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load this data \(unauthorized\)/)).toBeInTheDocument();
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("renders the not-connected empty state", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/realtime": { body: { status: "not_connected" } },
      "/api/analytics/overview": { body: { status: "not_connected" } },
      "/api/analytics/pages": { body: { status: "not_connected" } },
      "/api/analytics/search-console": { body: { status: "not_connected" } },
      "/api/analytics/adsense": { body: { status: "not_connected" } },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getAllByText("Not connected").length).toBe(5));
  });

  it("renders the missing-data empty state with the server reason", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/overview": {
        body: { status: "missing_data", unavailableWebsites: [{ reason: "No GA4 property mapped" }] },
      },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByText("No GA4 property mapped")).toBeInTheDocument());
  });

  it("renders the missing-data default hint when no reason is given", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/overview": { body: { status: "missing_data" } },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByText("Map a Google property to this website first.")).toBeInTheDocument());
  });

  it("shows 'Last synced: never' when no sync timestamp exists", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/realtime": { body: { status: "ok", data: { activeUsers: 1, eventCount: 0, byCountry: [] } } },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getAllByText("Last synced: never").length).toBeGreaterThan(0));
  });

  // A-FE-16: realtime metrics must go through formatMetric so a payload
  // missing activeUsers/eventCount renders "—" instead of blank.
  it("renders dashes when the realtime payload is missing activeUsers and eventCount", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/realtime": { body: { status: "ok", data: { byCountry: [] } } },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByText("Active users")).toBeInTheDocument());
    expect(screen.getByText("Events")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  // A-FE-16: the top-pages bar chart needs a text alternative — a
  // visually-hidden table carrying the same rows for assistive tech.
  it("exposes the top-pages chart data in a visually-hidden table", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/pages": {
        body: {
          status: "ok",
          data: {
            rows: [
              { dimension0: "/home", screenPageViews: 100 },
              { dimension0: "/pricing", screenPageViews: 42 },
            ],
          },
        },
      },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByRole("img", { name: /Bar chart of top pages/ })).toBeInTheDocument());
    const table = screen.getByRole("table");
    expect(table).toHaveClass("sr-only");
    expect(screen.getByRole("cell", { name: "/home" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "100" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "/pricing" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "42" })).toBeInTheDocument();
  });
});

describe("gap closure: unparseable bodies, metric formatting, all retries", () => {
  it("treats unparseable bodies as empty data, not errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          },
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAnalytics();
    await waitFor(() => expect(screen.getByText("Historical overview")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.queryByText(/Couldn't load this data/)).not.toBeInTheDocument();
  });

  it("formats null, empty and non-number summary values as dashes or text", async () => {
    mockFetchRoutes({
      ...okRoutes,
      "/api/analytics/overview": {
        body: {
          status: "ok",
          data: {
            summary: { totalUsers: null, sessions: "", activeUsers: "many", engagementRate: 0 },
            rows: [],
          },
        },
      },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getByText("Total users")).toBeInTheDocument());
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("many")).toBeInTheDocument();
    expect(screen.getByText("0.0%")).toBeInTheDocument(); // engagementRate 0
  });

  it("retries every failed section from its own Retry button", async () => {
    const fetchMock = mockFetchRoutes({
      "/api/analytics/realtime": { body: { error: "temporarily_unavailable" }, ok: false, status: 503 },
      "/api/analytics/overview": { body: { error: "permission_denied" }, ok: false, status: 403 },
      "/api/analytics/pages": { body: { error: "scope_missing" }, ok: false, status: 403 },
      "/api/analytics/search-console": { body: { error: "google_quota_exceeded" }, ok: false, status: 429 },
      "/api/analytics/adsense": { body: { error: "invalid_request" }, ok: false, status: 400 },
    });
    renderAnalytics();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(5));
    expect(screen.getByText(/token refresh is busy right now/)).toBeInTheDocument();
    expect(screen.getByText(/lacks access to this property/)).toBeInTheDocument();
    expect(screen.getByText(/missing a required permission/)).toBeInTheDocument();
    expect(screen.getByText(/Google quota exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/Google rejected the report request/)).toBeInTheDocument();
    const callsBefore = fetchMock.mock.calls.length;
    for (const btn of screen.getAllByRole("button", { name: "Retry" })) {
      fireEvent.click(btn);
    }
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 5));
  });
});
