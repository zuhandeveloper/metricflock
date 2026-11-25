// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MobileNav from "@/components/MobileNav";
import { mockFetch } from "./helpers";

// A-FE-19: the mobile nav drawer is role="dialog" aria-modal="true", so
// Tab must cycle inside it instead of escaping into the obscured page.
// The general drawer behavior (open/close/focus return/Escape) is
// covered in NavComponents.test.tsx; this file pins the focus trap.
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/dashboard",
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
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/dashboard";
  nav.searchParams = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const member = { name: "Ada", email: "ada@example.com", role: "TEAM_MEMBER" };

function openDrawer() {
  mockFetch(null);
  render(<MobileNav user={member} />);
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  return {
    closeBtn: screen.getByRole("button", { name: "Close navigation" }),
    signOutBtn: screen.getByRole("button", { name: "Sign out" }),
  };
}

describe("MobileNav focus trap (A-FE-19)", () => {
  it("wraps Tab from the last focusable element back to the first", () => {
    const { closeBtn, signOutBtn } = openDrawer();
    signOutBtn.focus();
    expect(signOutBtn).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeBtn).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable element to the last", () => {
    const { closeBtn, signOutBtn } = openDrawer();
    // Focus lands on the close button on open.
    expect(closeBtn).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(signOutBtn).toHaveFocus();
  });

  it("pulls focus back into the drawer when Tab is pressed with focus outside it", () => {
    const { closeBtn } = openDrawer();
    const openBtn = screen.getByRole("button", { name: "Open navigation" });
    openBtn.focus();
    expect(openBtn).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeBtn).toHaveFocus();
  });

  it("does not move focus for Tab in the middle of the drawer", () => {
    openDrawer();
    const dashboardLink = screen.getByRole("link", { name: "Dashboard" });
    dashboardLink.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dashboardLink).toHaveFocus();
  });
});
