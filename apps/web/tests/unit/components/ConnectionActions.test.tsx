// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DisconnectButton, DiscoverButton, MapPropertyForm } from "@/app/(app)/integrations/ConnectionActions";
import { mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/integrations",
  searchParams: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, replace: nav.replace }),
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DisconnectButton", () => {
  it("disconnects after confirm and refreshes", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<DisconnectButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/google/connections/disconnect",
      expect.objectContaining({ body: JSON.stringify({ connectionId: "c1" }) }),
    );
  });

  it("does nothing when confirm is dismissed", () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<DisconnectButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error on failure", async () => {
    mockConfirm(true);
    mockFetch({ error: "not_found" }, false, 404);
    render(<DisconnectButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not_found"));
  });
});

describe("DiscoverButton", () => {
  it("shows the discovery summary and refreshes", async () => {
    const fetchMock = mockFetch({ ga4: [{}, {}], searchConsole: [{}], adsense: [] });
    render(<DiscoverButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Discover properties" }));
    await waitFor(() => expect(screen.getByText("Found 2 GA4, 1 Search Console, 0 AdSense.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/google/properties/discover",
      expect.objectContaining({ body: JSON.stringify({ connectionId: "c1" }) }),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("maps provider errors to human hints", async () => {
    mockFetch({ ga4: [], searchConsole: [], adsense: [], errors: { ga4: "api_not_enabled", adsense: "weird_code" } });
    render(<DiscoverButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Discover properties" }));
    await waitFor(() => expect(screen.getByText("GA4: API not enabled in Google Cloud Console")).toBeInTheDocument());
    expect(screen.getByText("AdSense: weird_code")).toBeInTheDocument();
  });

  it("includes the Ad Manager count when the response carries it (A-GGL-10)", async () => {
    mockFetch({ ga4: [], searchConsole: [], adsense: [], adManager: [{}, {}] });
    render(<DiscoverButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Discover properties" }));
    await waitFor(() =>
      expect(screen.getByText("Found 0 GA4, 0 Search Console, 0 AdSense, 2 Ad Manager.")).toBeInTheDocument(),
    );
  });

  it("labels Ad Manager provider errors (A-GGL-10)", async () => {
    mockFetch({
      ga4: [],
      searchConsole: [],
      adsense: [],
      adManager: [],
      errors: { adManager: "api_not_enabled" },
    });
    render(<DiscoverButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Discover properties" }));
    await waitFor(() =>
      expect(screen.getByText("Ad Manager: API not enabled in Google Cloud Console")).toBeInTheDocument(),
    );
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "unauthorized" }, false, 401);
    render(<DiscoverButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Discover properties" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unauthorized"));
  });
});

describe("MapPropertyForm", () => {
  const websites = [
    { id: "w1", name: "Blog" },
    { id: "w2", name: "Shop" },
  ];

  it("shows the add-a-website message when there are no websites", () => {
    render(<MapPropertyForm provider="GA4" externalId="123" connectionId="c1" websites={[]} />);
    expect(screen.getByText("Add a website first to map this property.")).toBeInTheDocument();
  });

  it("maps a property with the primary flag and shows Mapped.", async () => {
    const fetchMock = mockFetch(null);
    render(
      <MapPropertyForm
        provider="GA4"
        externalId="123"
        resourceName="properties/123"
        connectionId="c1"
        websites={websites}
        mappedTo="Old Site"
      />,
    );
    expect(screen.getByText("Mapped to: Old Site")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Website for 123"), { target: { value: "w2" } });
    fireEvent.click(screen.getByLabelText("Primary"));
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await waitFor(() => expect(screen.getByText("Mapped.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/google/properties/map",
      expect.objectContaining({
        body: JSON.stringify({
          websiteId: "w2",
          provider: "GA4",
          externalId: "123",
          connectionId: "c1",
          resourceName: "properties/123",
          isPrimary: false,
        }),
      }),
    );
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "already_mapped" }, false, 409);
    render(<MapPropertyForm provider="SEARCH_CONSOLE" externalId="sc://x" connectionId="c1" websites={websites} />);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already_mapped"));
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("DisconnectButton: an unparseable error body falls back to request_failed", async () => {
    mockConfirm(true);
    mockFetchBadJson(false, 500);
    render(<DisconnectButton connectionId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("DisconnectButton: a double click only disconnects once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<DisconnectButton connectionId="c1" />);
    const btn = screen.getByRole("button", { name: "Disconnect" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DiscoverButton: a double click only discovers once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed({ ga4: [], searchConsole: [], adsense: [] });
    render(<DiscoverButton connectionId="c1" />);
    const btn = screen.getByRole("button", { name: "Discover properties" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Found 0 GA4, 0 Search Console, 0 AdSense.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("MapPropertyForm: a double submit only maps once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(
      <MapPropertyForm provider="GA4" externalId="123" connectionId="c1" websites={[{ id: "w1", name: "Blog" }]} />,
    );
    const form = screen.getByLabelText("Website for 123").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("Mapped.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
