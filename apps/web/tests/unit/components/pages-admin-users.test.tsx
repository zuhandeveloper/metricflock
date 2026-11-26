// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockFetch } from "./helpers";

// Self-contained mocks (not page-mocks): the page under test imports
// isPlatformAdmin from @metricflock/auth, which page-mocks would
// resolve to the real helper against a db mock without user.findFirst.
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  isPlatformAdmin: vi.fn(),
  userFindMany: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn() }),
  usePathname: () => "/admin/users",
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("@metricflock/auth", () => ({
  getSessionUser: mocks.getSessionUser,
  isPlatformAdmin: mocks.isPlatformAdmin,
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    user: { findMany: mocks.userFindMany },
  },
}));

import PlatformUsersPage from "@/app/(app)/admin/users/page";

const platformAdminUser = {
  id: "u1",
  organizationId: "org1",
  role: "SUPER_ADMIN",
  email: "root@example.com",
  name: "Root",
  twoFactorEnabled: false,
};

const allUsers = [
  {
    id: "u1",
    name: "Root",
    email: "root@example.com",
    role: "SUPER_ADMIN",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    organization: { name: "Org One" },
  },
  {
    id: "u2",
    name: "Manager Mia",
    email: "mia@example.com",
    role: "TEAM_ADMIN",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    organization: { name: "Org Two" },
  },
  {
    id: "u3",
    name: "Simple Sam",
    email: "sam@example.com",
    role: "TEAM_MEMBER",
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    organization: { name: "Org Two" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue(platformAdminUser);
  mocks.isPlatformAdmin.mockResolvedValue(true);
  mocks.userFindMany.mockResolvedValue(allUsers);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PlatformUsersPage", () => {
  it("redirects to /login when there is no session", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    await expect(PlatformUsersPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("shows the restricted state to non-platform-admins and never loads the user list", async () => {
    mocks.isPlatformAdmin.mockResolvedValue(false);
    const el = await PlatformUsersPage();
    render(el);
    expect(screen.getByText("Platform admin only")).toBeInTheDocument();
    expect(screen.queryByText("mia@example.com")).not.toBeInTheDocument();
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("lists users from multiple organizations with friendly role options", async () => {
    const el = await PlatformUsersPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Platform users" })).toBeInTheDocument();
    expect(screen.getByText("Org One")).toBeInTheDocument();
    expect(screen.getAllByText("Org Two")).toHaveLength(2);
    expect(screen.getByText("mia@example.com")).toBeInTheDocument();
    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
    const miaSelect = screen.getByLabelText("Role", { selector: "#platform-role-u2" }) as HTMLSelectElement;
    expect(miaSelect.value).toBe("TEAM_ADMIN");
    expect([...miaSelect.options].map((o) => o.textContent)).toEqual(["Super admin", "Manager", "Simple user"]);
  });

  it("disables the platform admin's own row", async () => {
    const el = await PlatformUsersPage();
    render(el);
    const ownSelect = screen.getByLabelText("Role", { selector: "#platform-role-u1" }) as HTMLSelectElement;
    expect(ownSelect.disabled).toBe(true);
    const otherSelect = screen.getByLabelText("Role", { selector: "#platform-role-u3" }) as HTMLSelectElement;
    expect(otherSelect.disabled).toBe(false);
  });

  it("PATCHes the platform route on change and refreshes", async () => {
    const fetchMock = mockFetch({ member: { id: "u3", email: "sam@example.com", role: "TEAM_ADMIN" } });
    const el = await PlatformUsersPage();
    render(el);
    const samSelect = screen.getByLabelText("Role", { selector: "#platform-role-u3" }) as HTMLSelectElement;
    fireEvent.change(samSelect, { target: { value: "TEAM_ADMIN" } });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/u3",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "TEAM_ADMIN" }) }),
    );
  });

  it("shows the API error inline and reverts the select on failure", async () => {
    mockFetch({ error: "last_super_admin" }, false, 409);
    const el = await PlatformUsersPage();
    render(el);
    const miaSelect = screen.getByLabelText("Role", { selector: "#platform-role-u2" }) as HTMLSelectElement;
    fireEvent.change(miaSelect, { target: { value: "TEAM_MEMBER" } });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("last_super_admin"));
    expect(miaSelect.value).toBe("TEAM_ADMIN");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
