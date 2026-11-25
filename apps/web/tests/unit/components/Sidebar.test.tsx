// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Sidebar from "@/components/Sidebar";
import { mockFetch, mockFetchImpl } from "./helpers";

// A-FE-20: sign-out must only navigate to /login when the logout
// request succeeds. On failure (non-2xx or network error) the session
// is still alive, so the user stays in the app with an error shown —
// the old try/finally navigated unconditionally, bouncing the user
// through /login back to /dashboard with no error.
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  pathname: "/dashboard",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  usePathname: () => nav.pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const member = { name: "Ada", email: "ada@example.com", role: "TEAM_MEMBER" };

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/dashboard";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar sign-out (A-FE-20)", () => {
  it("navigates to /login and refreshes when logout succeeds", async () => {
    mockFetch({ status: "ok" });
    render(<Sidebar user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(nav.refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays in the app with an error when the logout request returns 500", async () => {
    mockFetch({ error: "logout_failed" }, false, 500);
    render(<Sidebar user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't sign out/));
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
    // Session UI still visible and the button is usable again.
    expect(screen.getByText("ada@example.com · TEAM_MEMBER")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("stays in the app with an error when the logout request throws (network down)", async () => {
    mockFetchImpl(async () => {
      throw new Error("network down");
    });
    render(<Sidebar user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't sign out/));
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
