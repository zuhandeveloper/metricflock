// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AssignForm,
  DeleteWebsiteButton,
  EditWebsiteForm,
  SyncNowForm,
  TransferForm,
} from "@/app/(app)/websites/[id]/WebsiteActions";
import { fetchBody, jsonResponse, mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/websites/w1",
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

const teams = [
  { id: "t1", name: "Team One" },
  { id: "t2", name: "Team Two" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fillEditForm() {
  render(
    <EditWebsiteForm
      websiteId="w1"
      name="Blog"
      domain="blog.example"
      url="https://blog.example"
      status="ACTIVE"
      teamId="t1"
      teams={teams}
    />,
  );
}

describe("EditWebsiteForm", () => {
  it("renders initial values and saves on submit", async () => {
    const fetchMock = mockFetch(null);
    fillEditForm();
    expect(screen.getByLabelText("Name")).toHaveValue("Blog");
    expect(screen.getByLabelText("Domain")).toHaveValue("blog.example");
    expect(screen.getByLabelText("URL")).toHaveValue("https://blog.example");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Blog" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/websites/w1",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"name":"New Blog"'),
      }),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("shows the server error and does not mark saved", async () => {
    mockFetch({ error: "domain_taken" }, false, 409);
    fillEditForm();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("domain_taken"));
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("falls back to request_failed_<status> when the error body is empty", async () => {
    mockFetch(null, false, 500);
    fillEditForm();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("disables the submit button while saving and includes teamId only when set", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse(null)), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fillEditForm();
    const btn = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled());
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchBody(fetchMock)).teamId).toBe("t1");
  });

  it("omits teamId from the payload when no team is selected", async () => {
    const fetchMock = mockFetch(null);
    render(
      <EditWebsiteForm
        websiteId="w1"
        name="Blog"
        domain="blog.example"
        url="https://blog.example"
        status="ACTIVE"
        teamId={null}
        teams={teams}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(JSON.parse(fetchBody(fetchMock))).not.toHaveProperty("teamId");
  });

  it("A-FE-09: the status select lists the documented client-settable set (incl. SOLD, not TRANSFER_PENDING)", () => {
    fillEditForm();
    const select = screen.getByLabelText("Status");
    const values = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(values).toEqual(["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "SOLD", "ARCHIVED"]);
  });
});

describe("DeleteWebsiteButton", () => {
  it("deletes after confirm and navigates to /websites", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<DeleteWebsiteButton websiteId="w1" domain="blog.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete website" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/websites"));
    expect(fetchMock).toHaveBeenCalledWith("/api/websites/w1", expect.objectContaining({ method: "DELETE" }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("does nothing when the confirm is dismissed", async () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<DeleteWebsiteButton websiteId="w1" domain="blog.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete website" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server error on failure", async () => {
    mockConfirm(true);
    mockFetch({ error: "has_active_transfers" }, false, 409);
    render(<DeleteWebsiteButton websiteId="w1" domain="blog.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete website" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("has_active_transfers"));
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("AssignForm", () => {
  const orgUsers = [
    { id: "u1", email: "a@example.com", role: "TEAM_MEMBER" },
    { id: "u2", email: "b@example.com", role: "TEAM_ADMIN" },
  ];

  it("shows the empty state and the assign form for unassigned users", () => {
    render(<AssignForm websiteId="w1" assignments={[]} orgUsers={orgUsers} />);
    expect(screen.getByText("No members assigned to this website.")).toBeInTheDocument();
    expect(screen.getByLabelText("Assign member")).toBeInTheDocument();
  });

  it("assigns a selected user", async () => {
    const fetchMock = mockFetch(null);
    render(<AssignForm websiteId="w1" assignments={[]} orgUsers={orgUsers} />);
    fireEvent.change(screen.getByLabelText("Assign member"), { target: { value: "u2" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/websites/w1/assign",
      expect.objectContaining({ body: JSON.stringify({ userId: "u2", action: "assign" }) }),
    );
  });

  it("removes an assigned member and hides them from candidates", async () => {
    const fetchMock = mockFetch(null);
    render(<AssignForm websiteId="w1" assignments={[{ userId: "u1", email: "a@example.com" }]} orgUsers={orgUsers} />);
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    // u1 is assigned, so only u2 is a candidate
    expect(screen.getByLabelText("Assign member").textContent).not.toContain("a@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/websites/w1/assign",
      expect.objectContaining({ body: JSON.stringify({ userId: "u1", action: "remove" }) }),
    );
  });

  it("shows an error when assign fails and hides the form when everyone is assigned", async () => {
    mockFetch({ error: "forbidden" }, false, 403);
    render(
      <AssignForm
        websiteId="w1"
        assignments={[
          { userId: "u1", email: "a@example.com" },
          { userId: "u2", email: "b@example.com" },
        ]}
        orgUsers={orgUsers}
      />,
    );
    expect(screen.queryByLabelText("Assign member")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("forbidden"));
  });
});

describe("TransferForm", () => {
  it("shows the no-target message when there is no other team", () => {
    render(<TransferForm websiteId="w1" currentTeamId="t1" teams={[{ id: "t1", name: "Team One" }]} />);
    expect(screen.getByText(/No other team to transfer to/)).toBeInTheDocument();
  });

  it("starts a transfer with destination and reason", async () => {
    const fetchMock = mockFetch(null);
    render(<TransferForm websiteId="w1" currentTeamId="t1" teams={teams} />);
    expect(screen.getByLabelText("Destination team")).toHaveValue("t2");
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "Selling" } });
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    await waitFor(() =>
      expect(screen.getByText("Transfer started — destination team must accept.")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/websites/w1/transfer",
      expect.objectContaining({ body: JSON.stringify({ toTeamId: "t2", reason: "Selling" }) }),
    );
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "transfer_pending" }, false, 409);
    render(<TransferForm websiteId="w1" currentTeamId={null} teams={teams} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("transfer_pending"));
  });
});

describe("SyncNowForm", () => {
  it("queues a sync and maps queue_unavailable to the worker hint", async () => {
    const fetchMock = mockFetch(null);
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.change(screen.getByLabelText("Sync type"), { target: { value: "adsense-sync" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({ body: JSON.stringify({ websiteId: "w1", type: "adsense-sync" }) }),
    );
  });

  it("shows the queue_unavailable hint text", async () => {
    mockFetch({ error: "queue_unavailable" }, false, 503);
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("queue_unavailable (worker/Redis not running)"),
    );
  });

  it("already_queued shows the hour message instead of Queued.", async () => {
    mockFetch({ status: "already_queued", queued: true, syncJobId: "job-row-1" });
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Already queued for this hour.")).toBeInTheDocument());
    expect(screen.queryByText("Queued.")).not.toBeInTheDocument();
  });

  it("already_completed shows the synced message", async () => {
    mockFetch({ status: "already_completed", queued: false, syncJobId: "job-row-1" });
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Already synced this hour.")).toBeInTheDocument());
  });

  it("lists all seven sync types", () => {
    render(<SyncNowForm websiteId="w1" />);
    for (const label of [
      "GA4 realtime",
      "GA4 historical",
      "Search Console",
      "AdSense",
      "Ad Manager",
      "Cache refresh",
      "Health check",
    ]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
  });

  it("A-FE-07: queues a GA4 realtime sync and refreshes the page to show the new job", async () => {
    const fetchMock = mockFetch(null);
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.change(screen.getByLabelText("Sync type"), { target: { value: "ga4-realtime-sync" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({ body: JSON.stringify({ websiteId: "w1", type: "ga4-realtime-sync" }) }),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("A-FE-07: queues a cache refresh", async () => {
    const fetchMock = mockFetch(null);
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.change(screen.getByLabelText("Sync type"), { target: { value: "analytics-cache-refresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync",
      expect.objectContaining({ body: JSON.stringify({ websiteId: "w1", type: "analytics-cache-refresh" }) }),
    );
  });
});

describe("gap closure: json parse failures, busy guards, all field changes", () => {
  it("EditWebsiteForm: changing every field posts the new values", async () => {
    const fetchMock = mockFetch(null);
    fillEditForm();
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "new.example" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://new.example" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ARCHIVED" } });
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(JSON.parse(fetchBody(fetchMock))).toEqual({
      name: "Blog",
      domain: "new.example",
      url: "https://new.example",
      status: "ARCHIVED",
      teamId: "t2",
    });
  });

  it("EditWebsiteForm: a double submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    fillEditForm();
    const form = screen.getByLabelText("Name").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("EditWebsiteForm: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    fillEditForm();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("DeleteWebsiteButton: an unparseable error body falls back to request_failed", async () => {
    mockConfirm(true);
    mockFetchBadJson(false, 500);
    render(<DeleteWebsiteButton websiteId="w1" domain="blog.example" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete website" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("DeleteWebsiteButton: a double click only deletes once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<DeleteWebsiteButton websiteId="w1" domain="blog.example" />);
    const btn = screen.getByRole("button", { name: "Delete website" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/websites"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("AssignForm: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(
      <AssignForm
        websiteId="w1"
        assignments={[]}
        orgUsers={[{ id: "u1", email: "a@example.com", role: "TEAM_MEMBER" }]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Assign member"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("TransferForm: changing the destination team posts the new target", async () => {
    const fetchMock = mockFetch(null);
    render(<TransferForm websiteId="w1" currentTeamId="t1" teams={teams} />);
    fireEvent.change(screen.getByLabelText("Destination team"), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    await waitFor(() =>
      expect(screen.getByText("Transfer started — destination team must accept.")).toBeInTheDocument(),
    );
    expect(JSON.parse(fetchBody(fetchMock)).toTeamId).toBe("t2");
  });

  it("TransferForm: a double submit only starts one transfer (busy guard)", async () => {
    mockFetchDelayed(null);
    render(<TransferForm websiteId="w1" currentTeamId="t1" teams={teams} />);
    const form = screen.getByLabelText("Destination team").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Start transfer" }));
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByText("Transfer started — destination team must accept.")).toBeInTheDocument(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("SyncNowForm: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<SyncNowForm websiteId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("SyncNowForm: a double submit only queues once (busy guard)", async () => {
    mockFetchDelayed(null);
    render(<SyncNowForm websiteId="w1" />);
    const form = screen.getByLabelText("Sync type").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("Queued.")).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
