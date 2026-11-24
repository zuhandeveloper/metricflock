// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrgAdminActions } from "@/app/(app)/members/OrgAdminForms";
import { mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/members",
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

describe("OrgAdminActions", () => {
  it("links to the export endpoint and shows the slug hint", () => {
    mockFetch(null);
    render(<OrgAdminActions orgSlug="acme" />);
    expect(screen.getByRole("link", { name: "Download export (JSON)" })).toHaveAttribute(
      "href",
      "/api/organization/export",
    );
    expect(screen.getByLabelText("Organization slug")).toHaveAttribute("placeholder", "acme");
  });

  it("deletes the organization after confirm and navigates to /login", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<OrgAdminActions orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/organization",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirmSlug: "acme" }) }),
    );
  });

  it("does nothing when confirm is dismissed", () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<OrgAdminActions orgSlug="acme" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error on failure", async () => {
    mockConfirm(true);
    mockFetch({ error: "slug_mismatch" }, false, 400);
    render(<OrgAdminActions orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("slug_mismatch"));
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("gap closure: json parse failure and busy guard", () => {
  it("shows request_failed when the error body is unparseable", async () => {
    mockConfirm(true);
    mockFetchBadJson(false, 500);
    render(<OrgAdminActions orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("a double click only deletes once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<OrgAdminActions orgSlug="acme" />);
    fireEvent.change(screen.getByLabelText("Organization slug"), { target: { value: "acme" } });
    const btn = screen.getByRole("button", { name: "Delete organization" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
