// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiKeyManager } from "@/app/(app)/settings/api-keys/ApiKeyManager";
import { mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/settings/api-keys",
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

const keys = [
  {
    id: "k1",
    name: "Reporting",
    prefix: "mf_live_abc",
    lastUsedAt: "2026-11-22T10:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-11-20T10:00:00.000Z",
  },
  {
    id: "k2",
    name: "Old script",
    prefix: "mf_live_old",
    lastUsedAt: null,
    revokedAt: "2026-11-21T10:00:00.000Z",
    createdAt: "2026-11-19T10:00:00.000Z",
  },
];

describe("ApiKeyManager", () => {
  it("shows the empty state with no keys", () => {
    mockFetch(null);
    render(<ApiKeyManager initial={[]} />);
    expect(screen.getByText("No API keys yet.")).toBeInTheDocument();
  });

  it("lists keys with status badges and a Revoke button only for active keys", () => {
    mockFetch(null);
    render(<ApiKeyManager initial={keys} />);
    expect(screen.getByText("Reporting")).toBeInTheDocument();
    expect(screen.getByText("mf_live_abc…")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    expect(screen.getByText("—")).toBeInTheDocument(); // never used
  });

  it("creates a key and shows the secret once", async () => {
    const fetchMock = mockFetch({ secret: "mf_live_SUPERSECRET" });
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "  New key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() => expect(screen.getByText("mf_live_SUPERSECRET")).toBeInTheDocument());
    expect(screen.getByText(/Copy this secret now/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/api-keys",
      expect.objectContaining({ body: JSON.stringify({ name: "New key" }) }),
    );
    expect(screen.getByLabelText(/Key name/)).toHaveValue("");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("does not create a key with a blank name", () => {
    const fetchMock = mockFetch(null);
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error when creation fails", async () => {
    mockFetch({ error: "limit_reached" }, false, 403);
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("limit_reached"));
  });

  it("revokes a key after confirm", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/api-keys/k1", expect.objectContaining({ method: "DELETE" }));
  });

  it("does not revoke when confirm is dismissed and shows revoke errors", async () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error when revoking fails", async () => {
    mockConfirm(true);
    mockFetch({ error: "not_found" }, false, 404);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not_found"));
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("creates with an unparseable error body falling back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "Key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("revokes with an unparseable error body falling back to request_failed", async () => {
    mockConfirm(true);
    mockFetchBadJson(false, 500);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("a double revoke only posts once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<ApiKeyManager initial={keys} />);
    const btn = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a double create only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed({ secret: "mf_live_X" });
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "Key" } });
    const btn = screen.getByRole("button", { name: "Create API key" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("mf_live_X")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
