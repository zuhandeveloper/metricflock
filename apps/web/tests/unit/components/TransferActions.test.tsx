// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TransferActions from "@/app/(app)/transfers/TransferActions";
import { mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";
import type { TransferStatus } from "@metricflock/db";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/transfers",
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

describe("TransferActions", () => {
  // A-FE-14: actions render exactly for the open (reachable) statuses —
  // the same set as OPEN_TRANSFER_STATUSES in @/lib/transfers (pinned
  // server-side in transfer-concurrency.test.ts; the create route sets
  // PENDING_ACCEPTANCE directly and INITIATED was dropped by A-DB-14).
  // The Record type makes a new enum value fail typecheck until this
  // table is revisited.
  const OPEN_BY_STATUS: Record<TransferStatus, boolean> = {
    PENDING_ACCEPTANCE: true,
    PENDING_CONNECTION: true,
    COMPLETED: false,
    CANCELLED: false,
    FAILED: false,
    EXPIRED: false,
  };
  it.each(Object.entries(OPEN_BY_STATUS))("renders actions for %s only when the status is open", (status, open) => {
    mockFetch(null);
    const { container } = render(
      <TransferActions transferId="tr1" status={status} canDestination={true} canCancel={true} />,
    );
    if (open) {
      expect(container).not.toBeEmptyDOMElement();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    } else {
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("renders nothing for a closed transfer", () => {
    mockFetch(null);
    const { container } = render(
      <TransferActions transferId="tr1" status="COMPLETED" canDestination={true} canCancel={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an unknown status", () => {
    mockFetch(null);
    const { container } = render(
      <TransferActions transferId="tr1" status="CANCELLED" canDestination={true} canCancel={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("accepts and rejects a pending-acceptance transfer for the destination", async () => {
    const fetchMock = mockFetch(null);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/tr1/accept", expect.objectContaining({ method: "POST" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/transfers/tr1/reject",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("hides accept/reject when the viewer is not the destination", () => {
    mockFetch(null);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={false} canCancel={true} />);
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("completes a pending-connection transfer", async () => {
    const fetchMock = mockFetch(null);
    render(<TransferActions transferId="tr1" status="PENDING_CONNECTION" canDestination={true} canCancel={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Complete transfer" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/tr1/complete", expect.objectContaining({ method: "POST" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("cancels a pending transfer", async () => {
    const fetchMock = mockFetch(null);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={false} canCancel={true} />);
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers/tr1/cancel", expect.objectContaining({ method: "POST" }));
  });

  it("shows the server error and falls back to action_failed", async () => {
    mockFetch({ error: "not_allowed" }, false, 403);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not_allowed"));
  });

  it("falls back to action_failed when the error body is empty", async () => {
    mockFetch(null, false, 500);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("action_failed"));
  });

  it("disables all buttons while an action is in flight", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => null } as Response), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("shows action_failed when the error body is unparseable", async () => {
    mockFetchBadJson(false, 500);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("action_failed"));
  });

  it("a double click only fires one action (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<TransferActions transferId="tr1" status="PENDING_ACCEPTANCE" canDestination={true} canCancel={false} />);
    const btn = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
