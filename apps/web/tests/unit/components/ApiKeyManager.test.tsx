// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiKeyManager } from "@/app/(app)/settings/api-keys/ApiKeyManager";
import { mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed, fetchBody } from "./helpers";

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
    expiresAt: null,
    scopes: [],
    createdAt: "2026-11-20T10:00:00.000Z",
  },
  {
    id: "k2",
    name: "Old script",
    prefix: "mf_live_old",
    lastUsedAt: null,
    revokedAt: "2026-11-21T10:00:00.000Z",
    expiresAt: "2026-12-20T10:00:00.000Z",
    scopes: ["websites:read"],
    createdAt: "2026-11-19T10:00:00.000Z",
  },
  {
    id: "k3",
    name: "Expired script",
    prefix: "mf_live_exp",
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: "2020-01-01T00:00:00.000Z",
    scopes: ["health:read"],
    createdAt: "2026-11-18T10:00:00.000Z",
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
    expect(screen.getAllByText("—")).toHaveLength(2); // k2 + k3 never used
  });

  // A-SEC-09 — expiry and scopes are surfaced in the list.
  it("shows expiry and scopes, and an Expired badge for a past-due key", () => {
    mockFetch(null);
    render(<ApiKeyManager initial={keys} />);
    expect(screen.getByText("Never")).toBeInTheDocument(); // k1: no expiry
    expect(screen.getByText("All")).toBeInTheDocument(); // k1: legacy full access
    expect(screen.getByText("websites:read")).toBeInTheDocument(); // k2's scopes
    expect(screen.getByText("health:read")).toBeInTheDocument(); // k3's scopes
    expect(screen.getByText("Expired")).toBeInTheDocument(); // k3
    // Expired keys get no Rotate/Revoke buttons — only the active key does.
    expect(screen.getAllByRole("button", { name: "Rotate" })).toHaveLength(1);
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
      expect.objectContaining({ body: JSON.stringify({ name: "New key", scopes: [] }) }),
    );
    expect(screen.getByLabelText(/Key name/)).toHaveValue("");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("creates a scoped key with an expiry when scopes are unchecked and days are set", async () => {
    const fetchMock = mockFetch({ secret: "mf_live_SCOPED" });
    render(<ApiKeyManager initial={[]} />);
    fireEvent.change(screen.getByLabelText(/Key name/), { target: { value: "Scoped" } });
    fireEvent.change(screen.getByLabelText(/Expires in days/), { target: { value: "90" } });
    fireEvent.click(screen.getByLabelText("Portfolio")); // uncheck → subset
    fireEvent.click(screen.getByLabelText("Insights")); // uncheck → subset
    fireEvent.click(screen.getByLabelText("Health")); // uncheck → subset
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    await waitFor(() => expect(screen.getByText("mf_live_SCOPED")).toBeInTheDocument());
    const body = JSON.parse(fetchBody(fetchMock)) as {
      name?: string;
      expiresAt?: string;
      scopes?: string[];
    };
    expect(body.name).toBe("Scoped");
    expect(body.scopes).toEqual(["websites:read"]);
    expect(typeof body.expiresAt).toBe("string");
    expect(new Date(body.expiresAt ?? "").getTime()).toBeGreaterThan(Date.now());
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

  it("rotates a key after confirm and shows the new secret once", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch({ secret: "mf_live_ROTATED" });
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(screen.getByText("mf_live_ROTATED")).toBeInTheDocument());
    expect(screen.getByText(/Copy this secret now/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/api-keys/k1/rotate", expect.objectContaining({ method: "POST" }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("does not rotate when confirm is dismissed", async () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error when rotating fails", async () => {
    mockConfirm(true);
    mockFetch({ error: "key_expired" }, false, 400);
    render(<ApiKeyManager initial={keys} />);
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("key_expired"));
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
