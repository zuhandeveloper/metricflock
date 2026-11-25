// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import DateRangePicker from "@/components/DateRangePicker";
import ThemeToggle from "@/components/ThemeToggle";
import QueryProvider from "@/components/QueryProvider";
import { mockFetch } from "./helpers";

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
const superAdmin = { name: null, email: "root@example.com", role: "SUPER_ADMIN" };

describe("Sidebar", () => {
  it("marks the active link and hides super-admin links from members", () => {
    mockFetch(null);
    render(<Sidebar user={member} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com · TEAM_MEMBER")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Sync jobs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Weekly reports" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "API keys" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Websites" })).not.toHaveAttribute("aria-current");
  });

  it("shows super-admin links and the email fallback name for super admins", () => {
    mockFetch(null);
    render(<Sidebar user={superAdmin} />);
    expect(screen.getByText("root@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sync jobs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Weekly reports" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API keys" })).toBeInTheDocument();
  });

  it("marks a nested pathname as active", () => {
    mockFetch(null);
    nav.pathname = "/websites/w1";
    render(<Sidebar user={member} />);
    expect(screen.getByRole("link", { name: "Websites" })).toHaveAttribute("aria-current", "page");
  });

  it("signs out, navigates to /login and refreshes", async () => {
    const fetchMock = mockFetch(null);
    render(<Sidebar user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("still navigates to /login when logout fails", async () => {
    mockFetch(null, false, 500);
    render(<Sidebar user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled());
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
  });
});

describe("MobileNav", () => {
  it("opens the drawer, focuses the close button, and closes via the close button", () => {
    mockFetch(null);
    render(<MobileNav user={member} />);
    const openBtn = screen.getByRole("button", { name: "Open navigation" });
    expect(openBtn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(openBtn);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    expect(openBtn).toHaveFocus();
  });

  it("closes on backdrop click and on Escape", () => {
    mockFetch(null);
    const { container } = render(<MobileNav user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    const backdrop = container.querySelector(".bg-black\\/50");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });

  it("closes when the pathname changes", () => {
    mockFetch(null);
    const { rerender } = render(<MobileNav user={member} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    nav.pathname = "/websites";
    rerender(<MobileNav user={member} />);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });
});

describe("DateRangePicker", () => {
  it("defaults to 28d and pushes the chosen range preserving other params", () => {
    nav.searchParams = new URLSearchParams("page=2");
    render(<DateRangePicker />);
    expect(screen.getByRole("button", { name: "Last 28 days" })).toHaveClass("bg-zinc-900");
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(nav.push).toHaveBeenCalledWith("?page=2&range=7d");
  });

  it("highlights the range from the URL", () => {
    nav.searchParams = new URLSearchParams("range=90d");
    render(<DateRangePicker />);
    expect(screen.getByRole("button", { name: "Last 12 months" })).not.toHaveClass("bg-zinc-900");
    expect(screen.getByRole("button", { name: "Last 90 days" })).toHaveClass("bg-zinc-900");
  });

  it("renders all six ranges", () => {
    render(<DateRangePicker />);
    for (const label of ["Today", "Yesterday", "Last 7 days", "Last 28 days", "Last 90 days", "Last 12 months"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("exposes the active range to assistive tech via aria-pressed (A-FE-11)", () => {
    nav.searchParams = new URLSearchParams("range=90d");
    render(<DateRangePicker />);
    expect(screen.getByRole("button", { name: "Last 90 days" })).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Today", "Yesterday", "Last 7 days", "Last 28 days", "Last 12 months"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("marks the default 28d range as pressed and groups the buttons (A-FE-11)", () => {
    render(<DateRangePicker />);
    expect(screen.getByRole("button", { name: "Last 28 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Date range" })).toBeInTheDocument();
  });
});

describe("ThemeToggle", () => {
  // A-FE-12: the toggle persists via a `theme` cookie and follows the OS
  // preference on first visit — reset both between tests (jsdom has no
  // matchMedia, so stub it; default light).
  function stubMatchMedia(dark: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: dark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  beforeEach(() => {
    document.cookie = "theme=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    document.documentElement.classList.remove("dark");
    stubMatchMedia(false);
  });

  it("toggles the dark class on the document element", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: "Toggle dark mode" });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(btn);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("exposes pressed state (A-FE-12)", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: "Toggle dark mode" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("persists the choice in a cookie (A-FE-12)", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button", { name: "Toggle dark mode" });
    fireEvent.click(btn);
    expect(document.cookie).toContain("theme=dark");
    fireEvent.click(btn);
    expect(document.cookie).toContain("theme=light");
  });

  it("restores the persisted choice on mount (A-FE-12)", () => {
    document.cookie = "theme=dark; path=/";
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Toggle dark mode" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows prefers-color-scheme on first visit (A-FE-12)", () => {
    stubMatchMedia(true);
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.cookie).toContain("theme=dark");
  });
});

describe("QueryProvider", () => {
  it("renders children inside a query client", () => {
    render(
      <QueryProvider>
        <p>inner content</p>
      </QueryProvider>,
    );
    expect(screen.getByText("inner content")).toBeInTheDocument();
  });
});
