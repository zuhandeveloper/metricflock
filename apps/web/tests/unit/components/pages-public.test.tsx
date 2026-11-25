// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Home from "@/app/page";
import LoginPage from "@/app/login/page";
import ForgotPasswordPage from "@/app/forgot-password/page";
import ResetPasswordPage from "@/app/reset-password/[token]/page";
import InvitePage from "@/app/invite/[token]/page";
import NotFound from "@/app/not-found";
import AppLoading from "@/app/(app)/loading";
import AppError from "@/app/(app)/error";
import AppLayout from "@/app/(app)/layout";
import RootLayout from "@/app/layout";
import { pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { mockFetch } from "./helpers";

const authClient = vi.hoisted(() => ({ social: vi.fn() }));
vi.mock("@metricflock/auth/client", () => ({
  signIn: { social: authClient.social },
}));

beforeEach(() => {
  resetPageMocks();
  pageMocks.getSessionUser.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Home", () => {
  it("redirects signed-in users to /dashboard and others to /login", async () => {
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/login");
    pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
    await expect(Home()).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });
});

describe("LoginPage", () => {
  it("redirects signed-in users to /dashboard", async () => {
    pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
    await expect(LoginPage()).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });

  it("renders the login form for guests", async () => {
    mockFetch(null);
    const el = await LoginPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Sign in to MetricFlock" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });
});

describe("ForgotPasswordPage", () => {
  it("renders the forgot-password form", async () => {
    mockFetch(null);
    const el = await ForgotPasswordPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });
});

describe("ResetPasswordPage", () => {
  it("renders the reset form with the token from params", async () => {
    mockFetch(null);
    const el = await ResetPasswordPage({ params: Promise.resolve({ token: "tok-abc" }) });
    render(el);
    expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-very-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await screen.findByText(/Your password has been reset/);
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/reset-password",
      expect.objectContaining({ body: JSON.stringify({ newPassword: "a-very-long-password", token: "tok-abc" }) }),
    );
  });
});

describe("InvitePage", () => {
  const invite = {
    email: "new@example.com",
    role: "TEAM_MEMBER",
    invitedBy: { email: "admin@example.com" },
    organization: { name: "Acme" },
  };

  beforeEach(() => {
    pageMocks.organizationInviteFindFirst.mockResolvedValue(invite);
  });

  it("shows the invalid message when the invite is not found", async () => {
    mockFetch(null);
    pageMocks.organizationInviteFindFirst.mockResolvedValue(null);
    const el = await InvitePage({ params: Promise.resolve({ token: "bad" }) });
    render(el);
    expect(screen.getByText("This invite link is invalid, expired, or already used.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invite" })).not.toBeInTheDocument();
  });

  it("shows the accept button when the signed-in email matches", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue({ ...superAdminUser, email: "NEW@example.com" });
    const el = await InvitePage({ params: Promise.resolve({ token: "tok" }) });
    render(el);
    expect(screen.getByText(/invited/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept invite" })).toBeInTheDocument();
  });

  it("tells a mismatched signed-in user to switch accounts", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue({ ...superAdminUser, email: "someone-else@example.com" });
    const el = await InvitePage({ params: Promise.resolve({ token: "tok" }) });
    render(el);
    expect(screen.getByText(/You are signed in as someone-else@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invite" })).not.toBeInTheDocument();
  });

  it("points guests to sign in", async () => {
    mockFetch(null);
    const el = await InvitePage({ params: Promise.resolve({ token: "tok" }) });
    render(el);
    expect(screen.getByText(/Sign up or sign in with/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to sign in" })).toHaveAttribute("href", "/login");
  });
});

describe("NotFound", () => {
  it("renders the 404 card with a dashboard link", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toHaveAttribute("href", "/dashboard");
  });
});

describe("AppLoading", () => {
  it("renders the loading skeletons with a status role", () => {
    render(<AppLoading />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });
});

describe("AppError", () => {
  it("renders the error card with the digest and retries on click", () => {
    const reset = vi.fn();
    const error = new Error("boom") as Error & { digest?: string };
    error.digest = "abc123";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={error} reset={reset} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText(/quote reference abc123 when reporting it/)).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith("[app-error]", error);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it("falls back to n/a when there is no digest", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByText(/quote reference n\/a when reporting it/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe("AppLayout", () => {
  it("redirects to /login when there is no session", async () => {
    await expect(AppLayout({ children: <p>child</p> })).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders the sidebar, header and children for signed-in users", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
    const el = await AppLayout({ children: <p>child content</p> });
    render(el);
    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("button", { name: "Toggle dark mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("RootLayout", () => {
  it("renders children inside the query provider", async () => {
    const el = await RootLayout({ children: <p>root child</p> });
    render(el);
    expect(screen.getByText("root child")).toBeInTheDocument();
  });
});
