// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppLayout from "@/app/(app)/layout";

// A-SEC-08 regression tests for the (app) layout gate
// (owner decision 2026-11-26: 2FA mandatory for SUPER_ADMIN,
// recommended for other roles). Self-contained mocks — this file does
// not use page-mocks.tsx because it needs env control (the policy only
// activates on production deployments) and layout-specific stubs.

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn(), accountFindFirst: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@metricflock/auth", () => ({ getSessionUser: auth.getSessionUser }));
// The layout asks whether the gated user has a credential password
// (Google-only SUPER_ADMINs enrol without one) via @metricflock/db.
vi.mock("@metricflock/db", () => ({
  prisma: { account: { findFirst: auth.accountFindFirst } },
}));
vi.mock("@/components/Sidebar", () => ({
  default: () => (
    <div>
      sidebar <button type="button">Sign out</button>
    </div>
  ),
}));
vi.mock("@/components/MobileNav", () => ({ default: () => <div>mobile nav</div> }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => <button type="button">Dark / Light</button> }));
vi.mock("@/app/(app)/settings/security/SecurityActions", () => ({
  TwoFactorActions: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="two-factor-actions">2FA setup (enabled={String(enabled)})</div>
  ),
}));

const superAdminNo2fa = {
  id: "u1",
  organizationId: "org1",
  role: "SUPER_ADMIN",
  email: "admin@example.com",
  name: "Admin",
  twoFactorEnabled: false,
};
const superAdmin2fa = { ...superAdminNo2fa, twoFactorEnabled: true };
const memberNo2fa = {
  id: "u2",
  organizationId: "org1",
  role: "TEAM_MEMBER",
  email: "member@example.com",
  name: "Member",
  twoFactorEnabled: false,
};
const member2fa = { ...memberNo2fa, twoFactorEnabled: true };

function enforcementOn() {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NODE_ENV", "production");
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the user has a credential password (email/password account).
  auth.accountFindFirst.mockResolvedValue({ id: "acc1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AppLayout 2FA gate (A-SEC-08)", () => {
  it("blocks a SUPER_ADMIN without 2FA: setup screen instead of page content, sign-out still available", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(superAdminNo2fa);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("Two-factor authentication required")).toBeInTheDocument();
    expect(screen.getByTestId("two-factor-actions")).toBeInTheDocument();
    expect(screen.queryByText("secret page content")).not.toBeInTheDocument();
    // Sign-out lives in the sidebar, outside the gated content.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("still gates a Google-only SUPER_ADMIN (no credential password) — enrolment must not demand one", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(superAdminNo2fa);
    auth.accountFindFirst.mockResolvedValue(null);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("Two-factor authentication required")).toBeInTheDocument();
    expect(screen.getByTestId("two-factor-actions")).toBeInTheDocument();
    expect(auth.accountFindFirst).toHaveBeenCalledWith({
      where: { userId: "u1", providerId: "credential", password: { not: null } },
      select: { id: true },
    });
  });

  it("lets a SUPER_ADMIN with 2FA enabled through to page content", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(superAdmin2fa);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("secret page content")).toBeInTheDocument();
    expect(screen.queryByText("Two-factor authentication required")).not.toBeInTheDocument();
    expect(screen.queryByTestId("two-factor-actions")).not.toBeInTheDocument();
  });

  it("does not block non-SUPER_ADMIN users: content renders with the recommendation banner", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(memberNo2fa);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("secret page content")).toBeInTheDocument();
    expect(screen.queryByText("Two-factor authentication required")).not.toBeInTheDocument();
    expect(screen.getByText(/Two-factor authentication is off for your account/)).toBeInTheDocument();
  });

  it("shows no banner when the member already has 2FA enabled", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(member2fa);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("secret page content")).toBeInTheDocument();
    expect(screen.queryByText(/Two-factor authentication is off for your account/)).not.toBeInTheDocument();
  });

  it("does not gate outside production deployments (local dev / CI demo admin)", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("REQUIRE_SUPER_ADMIN_2FA", "");
    vi.stubEnv("NODE_ENV", "test");
    auth.getSessionUser.mockResolvedValue(superAdminNo2fa);
    const el = await AppLayout({ children: <p>secret page content</p> });
    render(el);
    expect(screen.getByText("secret page content")).toBeInTheDocument();
    expect(screen.queryByText("Two-factor authentication required")).not.toBeInTheDocument();
  });

  it("still redirects to /login when there is no session", async () => {
    enforcementOn();
    auth.getSessionUser.mockResolvedValue(null);
    await expect(AppLayout({ children: <p>child</p> })).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});
