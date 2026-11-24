// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreateTeamForm, DeleteTeamButton, TeamAdminControls } from "@/app/(app)/teams/TeamForms";
import { fetchBody, mockConfirm, mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/teams",
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

describe("DeleteTeamButton", () => {
  it("deletes after confirm and refreshes", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/teams/t1", expect.objectContaining({ method: "DELETE" }));
  });

  it("does nothing when confirm is dismissed", () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expands team_has_websites with the website count", async () => {
    mockConfirm(true);
    mockFetch({ error: "team_has_websites", websites: 3 }, false, 409);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "team_has_websites (3 website(s) — move or delete them first)",
      ),
    );
  });

  it("shows a generic error otherwise", async () => {
    mockConfirm(true);
    mockFetch({ error: "forbidden" }, false, 403);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("forbidden"));
  });
});

describe("CreateTeamForm", () => {
  it("auto-derives the slug from the name and creates the team", async () => {
    const fetchMock = mockFetch(null);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Content Sites!" } });
    expect(screen.getByLabelText("Slug")).toHaveValue("content-sites");
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams",
      expect.objectContaining({ body: JSON.stringify({ name: "Content Sites!", slug: "content-sites" }) }),
    );
    // form resets after success
    expect(screen.getByLabelText("Team name")).toHaveValue("");
    expect(screen.getByLabelText("Slug")).toHaveValue("");
  });

  it("keeps a manually edited slug and slugifies only via the fallback", async () => {
    const fetchMock = mockFetch(null);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "custom-slug" } });
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Other Name" } });
    expect(screen.getByLabelText("Slug")).toHaveValue("custom-slug");
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(JSON.parse(fetchBody(fetchMock)).slug).toBe("custom-slug");
  });

  it("shows the server error and keeps the form values", async () => {
    mockFetch({ error: "slug_taken" }, false, 409);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("slug_taken"));
    expect(screen.getByLabelText("Team name")).toHaveValue("Dup");
  });

  it("disables the button while creating", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => null } as Response), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Slow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled());
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("TeamAdminControls", () => {
  const members = [
    { userId: "u1", email: "a@example.com", role: "TEAM_MEMBER", isAdmin: false },
    { userId: "u2", email: "b@example.com", role: "TEAM_ADMIN", isAdmin: true },
  ];
  const orgUsers = [
    { id: "u1", email: "a@example.com", role: "TEAM_MEMBER" },
    { id: "u2", email: "b@example.com", role: "TEAM_ADMIN" },
    { id: "u3", email: "c@example.com", role: "TEAM_MEMBER" },
  ];
  function renderControls() {
    render(<TeamAdminControls teamId="t1" teamName="Alpha" members={members} orgUsers={orgUsers} />);
  }

  it("renames the team", async () => {
    const fetchMock = mockFetch(null);
    renderControls();
    fireEvent.change(screen.getByLabelText("Rename team"), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/t1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Beta" }) }),
    );
  });

  it("toggles team admin and removes a member", async () => {
    const fetchMock = mockFetch(null);
    renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/t1/members",
      expect.objectContaining({ body: JSON.stringify({ userId: "u1", isAdmin: true, action: "add" }) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove admin" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/teams/t1/members",
      expect.objectContaining({ body: JSON.stringify({ userId: "u1", action: "remove" }) }),
    );
  });

  it("adds a candidate member, optionally as admin", async () => {
    const fetchMock = mockFetch(null);
    renderControls();
    fireEvent.change(screen.getByLabelText("Add member"), { target: { value: "u3" } });
    fireEvent.click(screen.getByLabelText("Team admin"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/t1/members",
      expect.objectContaining({ body: JSON.stringify({ userId: "u3", isAdmin: true, action: "add" }) }),
    );
  });

  it("shows the all-users message when there are no candidates and surfaces errors", async () => {
    mockFetch({ error: "last_admin" }, false, 409);
    render(<TeamAdminControls teamId="t1" teamName="Alpha" members={members} orgUsers={orgUsers.slice(0, 2)} />);
    expect(screen.getByText("All organization users are already in this team.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("last_admin"));
  });
});

describe("gap closure: json parse failures, busy guards, empty add", () => {
  it("CreateTeamForm: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("DeleteTeamButton: an unparseable error body falls back to request_failed", async () => {
    mockConfirm(true);
    mockFetchBadJson(false, 500);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("DeleteTeamButton: a double click only deletes once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<DeleteTeamButton teamId="t1" teamName="Alpha" />);
    const btn = screen.getByRole("button", { name: "Delete team" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("CreateTeamForm: a double submit only creates once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<CreateTeamForm />);
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "X" } });
    const form = screen.getByLabelText("Team name").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    fireEvent.submit(form);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TeamAdminControls: a double rename only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(
      <TeamAdminControls
        teamId="t1"
        teamName="Alpha"
        members={[{ userId: "u1", email: "a@example.com", role: "TEAM_MEMBER", isAdmin: false }]}
        orgUsers={[{ id: "u1", email: "a@example.com", role: "TEAM_MEMBER" }]}
      />,
    );
    const form = screen.getByLabelText("Rename team").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.submit(form);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TeamAdminControls: submitting the add form with no user selected does nothing", async () => {
    const fetchMock = mockFetch(null);
    const { container } = render(
      <TeamAdminControls
        teamId="t1"
        teamName="Alpha"
        members={[]}
        orgUsers={[{ id: "u3", email: "c@example.com", role: "TEAM_MEMBER" }]}
      />,
    );
    const addForm = screen.getByLabelText("Add member").closest("form");
    expect(addForm).not.toBeNull();
    fireEvent.submit(addForm!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("form")).not.toBeNull();
  });
});
