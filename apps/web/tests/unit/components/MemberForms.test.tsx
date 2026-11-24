// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeleteMemberButton, InviteForm, RevokeInviteButton, RoleSelect } from "@/app/(app)/members/MemberForms";
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

describe("InviteForm", () => {
  it("sends an invite and shows the invite link", async () => {
    const fetchMock = mockFetch({ inviteUrl: "https://app/invite/abc" });
    render(<InviteForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "TEAM_ADMIN" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getByText("https://app/invite/abc")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/members/invite",
      expect.objectContaining({ body: JSON.stringify({ email: "new@example.com", role: "TEAM_ADMIN" }) }),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("");
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "already_member" }, false, 409);
    render(<InviteForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dup@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("already_member"));
  });

  it("disables the button while inviting", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve({ ok: true, status: 200, json: async () => ({ inviteUrl: "https://x" }) } as Response),
            200,
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<InviteForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Inviting…" })).toBeDisabled());
    await waitFor(() => expect(screen.getByText("https://x")).toBeInTheDocument());
  });
});

describe("RevokeInviteButton", () => {
  it("revokes and refreshes", async () => {
    const fetchMock = mockFetch(null);
    render(<RevokeInviteButton inviteId="inv1" />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/members/invite/inv1", expect.objectContaining({ method: "DELETE" }));
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "not_found" }, false, 404);
    render(<RevokeInviteButton inviteId="inv1" />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not_found"));
  });
});

describe("DeleteMemberButton", () => {
  it("deletes after confirm", async () => {
    mockConfirm(true);
    const fetchMock = mockFetch(null);
    render(<DeleteMemberButton memberId="m1" memberEmail="gone@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/members/m1", expect.objectContaining({ method: "DELETE" }));
  });

  it("does nothing when confirm is dismissed", () => {
    mockConfirm(false);
    const fetchMock = mockFetch(null);
    render(<DeleteMemberButton memberId="m1" memberEmail="gone@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("appends blocker details to the error", async () => {
    mockConfirm(true);
    mockFetch({ error: "member_has_dependencies", details: { connections: 2, transfers: 1 } }, false, 409);
    render(<DeleteMemberButton memberId="m1" memberEmail="gone@example.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "member_has_dependencies (2 connections, 1 transfers created by them)",
      ),
    );
  });
});

describe("RoleSelect", () => {
  it("offers SUPER_ADMIN only when allowed and patches on change", async () => {
    const fetchMock = mockFetch(null);
    const { rerender } = render(<RoleSelect memberId="m1" role="TEAM_MEMBER" canGrantSuperAdmin={true} />);
    expect(screen.getByRole("option", { name: "SUPER_ADMIN" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "TEAM_ADMIN" } });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/members/m1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "TEAM_ADMIN" }) }),
    );
    rerender(<RoleSelect memberId="m1" role="TEAM_MEMBER" canGrantSuperAdmin={false} />);
    expect(screen.queryByRole("option", { name: "SUPER_ADMIN" })).not.toBeInTheDocument();
  });

  it("reverts the select and shows the error when the patch fails", async () => {
    mockFetch({ error: "last_super_admin" }, false, 409);
    render(<RoleSelect memberId="m1" role="TEAM_MEMBER" canGrantSuperAdmin={true} />);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "SUPER_ADMIN" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("last_super_admin"));
    expect(screen.getByLabelText("Role")).toHaveValue("TEAM_MEMBER");
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("InviteForm: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<InviteForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("InviteForm: a double submit only invites once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed({ inviteUrl: "https://x" });
    render(<InviteForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    const form = screen.getByLabelText("Email").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("https://x")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("RevokeInviteButton: a double click only revokes once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<RevokeInviteButton inviteId="inv1" />);
    const btn = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DeleteMemberButton: a double click only deletes once (busy guard)", async () => {
    mockConfirm(true);
    const fetchMock = mockFetchDelayed(null);
    render(<DeleteMemberButton memberId="m1" memberEmail="gone@example.com" />);
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("RoleSelect: a double change only patches once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<RoleSelect memberId="m1" role="TEAM_MEMBER" canGrantSuperAdmin={true} />);
    const select = screen.getByLabelText("Role");
    fireEvent.change(select, { target: { value: "TEAM_ADMIN" } });
    fireEvent.change(select, { target: { value: "SUPER_ADMIN" } });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
