// @vitest-environment jsdom
import "./page-mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SecurityPage from "@/app/(app)/settings/security/page";
import ReportsSettingsPage from "@/app/(app)/settings/reports/page";
import ApiKeysPage from "@/app/(app)/settings/api-keys/page";
import ProfilePage from "@/app/(app)/settings/profile/page";
import { memberUser, pageMocks, resetPageMocks, superAdminUser } from "./page-state";
import { mockFetch } from "./helpers";

// ProfileActions talks to better-auth through its client — stub it so
// rendering the page never touches the network.
const client = vi.hoisted(() => ({ updateUser: vi.fn(), changePassword: vi.fn() }));
vi.mock("@metricflock/auth/client", () => ({
  authClient: { updateUser: client.updateUser, changePassword: client.changePassword },
}));

beforeEach(() => {
  resetPageMocks();
  pageMocks.getSessionUser.mockResolvedValue(superAdminUser);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SecurityPage", () => {
  beforeEach(() => {
    // Default: an email/password account (credential row with password).
    pageMocks.accountFindFirst.mockResolvedValue({ id: "acc1" });
    pageMocks.getSession.mockResolvedValue({ session: { token: "tok-current" } });
    pageMocks.listSessions.mockResolvedValue([
      {
        id: "s1",
        token: "tok-current",
        ipAddress: "1.2.3.4",
        userAgent: "Firefox",
        createdAt: "2026-11-20T10:00:00.000Z",
        expiresAt: "2026-12-20T10:00:00.000Z",
      },
      {
        id: "s2",
        token: "tok-other",
        ipAddress: null,
        userAgent: null,
        createdAt: "2026-11-19T09:00:00.000Z",
        expiresAt: "2026-12-19T09:00:00.000Z",
      },
    ]);
  });

  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(SecurityPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders the 2FA form and the session list with the current device marked", async () => {
    mockFetch(null);
    const el = await SecurityPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Account security" })).toBeInTheDocument();
    expect(screen.getByText(/Two-factor authentication is/)).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText("this device")).toBeInTheDocument();
    expect(screen.getByText("unknown IP")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out all other devices" })).toBeInTheDocument();
  });

  it("renders the disable form when 2FA is enabled", async () => {
    mockFetch(null);
    pageMocks.getSessionUser.mockResolvedValue({ ...superAdminUser, twoFactorEnabled: true });
    const el = await SecurityPage();
    render(el);
    expect(screen.getByRole("button", { name: "Disable two-factor" })).toBeInTheDocument();
  });

  it("handles a null session list", async () => {
    mockFetch(null);
    pageMocks.getSession.mockResolvedValue(null);
    pageMocks.listSessions.mockResolvedValue(null);
    const el = await SecurityPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Active sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  it("shows no password field in the 2FA form for a Google-only account", async () => {
    mockFetch(null);
    pageMocks.accountFindFirst.mockResolvedValue(null);
    const el = await SecurityPage();
    render(el);
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable two-factor" })).toBeInTheDocument();
  });
});

describe("ProfilePage", () => {
  it("redirects to /login when there is no session", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(ProfilePage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("renders name, read-only email and the set-password form for a Google-only account", async () => {
    mockFetch(null);
    pageMocks.accountFindFirst.mockResolvedValue(null);
    const el = await ProfilePage();
    render(el);
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue(superAdminUser.name);
    expect(screen.getByText(superAdminUser.email)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
    // The 2FA section is present and passwordless for this account.
    expect(screen.getByRole("button", { name: "Enable two-factor" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("renders the change-password form when the account already has a password", async () => {
    mockFetch(null);
    pageMocks.accountFindFirst.mockResolvedValue({ id: "acc1" });
    const el = await ProfilePage();
    render(el);
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set password" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
  });
});

describe("ReportsSettingsPage", () => {
  it("redirects to /login when there is no session and to /dashboard for non-admins", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(ReportsSettingsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    await expect(ReportsSettingsPage()).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });

  it("renders the schedule form with defaults when no schedule exists", async () => {
    mockFetch(null);
    pageMocks.reportScheduleFindUnique.mockResolvedValue(null);
    const el = await ReportsSettingsPage();
    render(el);
    expect(screen.getByRole("heading", { name: "Weekly reports" })).toBeInTheDocument();
    expect(screen.getByLabelText("Send the weekly report automatically")).not.toBeChecked();
    expect(screen.getByLabelText("Day (UTC)")).toHaveValue("1");
    expect(screen.getByLabelText("Hour (UTC, 0–23)")).toHaveValue(8);
  });

  it("renders the stored schedule including recipients and last-sent time", async () => {
    mockFetch(null);
    pageMocks.reportScheduleFindUnique.mockResolvedValue({
      enabled: true,
      dayOfWeek: 5,
      hourUtc: 10,
      recipients: ["a@example.com", 42, null],
      lastSentAt: new Date("2026-11-16T09:00:00.000Z"),
    });
    const el = await ReportsSettingsPage();
    render(el);
    expect(screen.getByLabelText("Send the weekly report automatically")).toBeChecked();
    expect(screen.getByLabelText("Day (UTC)")).toHaveValue("5");
    expect(screen.getByLabelText("Hour (UTC, 0–23)")).toHaveValue(10);
    expect(screen.getByLabelText(/Recipients/)).toHaveValue("a@example.com");
    expect(screen.getByText(/Last sent:/)).toBeInTheDocument();
  });
});

describe("ApiKeysPage", () => {
  it("redirects to /login when there is no session and to /dashboard for non-admins", async () => {
    pageMocks.getSessionUser.mockResolvedValue(null);
    await expect(ApiKeysPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    pageMocks.getSessionUser.mockResolvedValue(memberUser);
    await expect(ApiKeysPage()).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });

  it("renders the key manager with stored keys", async () => {
    mockFetch(null);
    pageMocks.apiKeyFindMany.mockResolvedValue([
      {
        id: "k1",
        name: "Reporting",
        prefix: "mf_live_abc",
        lastUsedAt: new Date("2026-11-22T10:00:00.000Z"),
        revokedAt: null,
        expiresAt: null,
        scopes: [],
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
      },
    ]);
    const el = await ApiKeysPage();
    render(el);
    expect(screen.getByRole("heading", { name: "API keys" })).toBeInTheDocument();
    expect(screen.getByText("Reporting")).toBeInTheDocument();
    expect(screen.getByText("mf_live_abc…")).toBeInTheDocument();
  });

  it("renders the empty state when there are no keys", async () => {
    mockFetch(null);
    pageMocks.apiKeyFindMany.mockResolvedValue([]);
    const el = await ApiKeysPage();
    render(el);
    expect(screen.getByText("No API keys yet.")).toBeInTheDocument();
  });
});
