// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddWebsiteForm } from "@/app/(app)/websites/WebsiteForms";
import { fetchBody, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/websites",
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

const teams = [
  { id: "t1", name: "Team One" },
  { id: "t2", name: "Team Two" },
];

describe("AddWebsiteForm", () => {
  it("shows the create-a-team message when there are no teams", () => {
    render(<AddWebsiteForm teams={[]} />);
    expect(screen.getByText(/Create a team first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add website" })).not.toBeInTheDocument();
  });

  it("auto-fills the URL from the domain and adds the website", async () => {
    const fetchMock = mockFetch(null);
    render(<AddWebsiteForm teams={teams} />);
    expect(screen.getByLabelText("Team")).toHaveValue("t1");
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "Blog" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "blog.example" } });
    expect(screen.getByLabelText("URL")).toHaveValue("https://blog.example");
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/websites",
      expect.objectContaining({
        body: JSON.stringify({ name: "Blog", domain: "blog.example", url: "https://blog.example", teamId: "t1" }),
      }),
    );
    expect(screen.getByLabelText("Website name")).toHaveValue("");
  });

  it("keeps a manually edited URL and uses the chosen team", async () => {
    const fetchMock = mockFetch(null);
    render(<AddWebsiteForm teams={teams} />);
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "Shop" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "shop.example" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://shop.example/custom" } });
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "t2" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "other.example" } });
    // URL was touched, so the domain change must not overwrite it
    expect(screen.getByLabelText("URL")).toHaveValue("https://shop.example/custom");
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchBody(fetchMock))).toEqual({
      name: "Shop",
      domain: "other.example",
      url: "https://shop.example/custom",
      teamId: "t2",
    });
  });

  it("shows the server error and keeps the form values", async () => {
    mockFetch({ error: "domain_taken" }, false, 409);
    render(<AddWebsiteForm teams={teams} />);
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "Dup" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "dup.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("domain_taken"));
    expect(screen.getByLabelText("Website name")).toHaveValue("Dup");
  });

  it("disables the button while adding", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => null } as Response), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AddWebsiteForm teams={teams} />);
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "Slow" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "slow.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled());
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("adds with an unparseable error body falling back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<AddWebsiteForm teams={teams} />);
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "x.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("a double submit only adds once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<AddWebsiteForm teams={teams} />);
    fireEvent.change(screen.getByLabelText("Website name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "x.example" } });
    const form = screen.getByLabelText("Website name").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Add website" }));
    fireEvent.submit(form);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
