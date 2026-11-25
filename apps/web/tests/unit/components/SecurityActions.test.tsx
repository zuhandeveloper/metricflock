// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionActions, TwoFactorActions } from "@/app/(app)/settings/security/SecurityActions";
import { mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/settings/security",
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

const sessions = [
  {
    id: "s1",
    token: "tok-current",
    ipAddress: "1.2.3.4",
    userAgent: "Firefox",
    createdAt: "2026-11-20T10:00:00.000Z",
    expiresAt: "2026-12-20T10:00:00.000Z",
    current: true,
  },
  {
    id: "s2",
    token: "tok-other",
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-11-19T09:00:00.000Z",
    expiresAt: "2026-12-19T09:00:00.000Z",
    current: false,
  },
];

describe("SessionActions", () => {
  it("renders sessions, marks the current device, and hides its Revoke button", () => {
    mockFetch(null);
    render(<SessionActions sessions={sessions} />);
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText("this device")).toBeInTheDocument();
    expect(screen.getByText("unknown IP")).toBeInTheDocument();
    expect(screen.getByText("unknown browser")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sign out all other devices" })).toBeInTheDocument();
  });

  it("revokes a single session", async () => {
    const fetchMock = mockFetch(null);
    render(<SessionActions sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/revoke-session",
      expect.objectContaining({ body: JSON.stringify({ token: "tok-other" }) }),
    );
  });

  it("signs out all other devices", async () => {
    const fetchMock = mockFetch(null);
    render(<SessionActions sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out all other devices" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/revoke-other-sessions", expect.objectContaining({}));
  });

  it("signs out everywhere and redirects to /login", async () => {
    const fetchMock = mockFetch(null);
    render(<SessionActions sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/revoke-sessions", expect.objectContaining({}));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("renders the sign-out-everywhere button even with a single session", () => {
    mockFetch(null);
    render(<SessionActions sessions={sessions.slice(0, 1)} />);
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  it("shows an error and stays put when sign-out-everywhere fails", async () => {
    mockFetch({ error: "revoke_failed" }, false, 500);
    render(<SessionActions sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't sign out everywhere."));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("hides the sign-out-others button with a single session", () => {
    mockFetch(null);
    render(<SessionActions sessions={sessions.slice(0, 1)} />);
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });
});

describe("TwoFactorActions", () => {
  it("enables 2FA: password step then shows setup key and backup codes", async () => {
    mockFetch({ totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", backupCodes: ["1111-2222", "3333-4444"] });
    render(<TwoFactorActions enabled={false} />);
    expect(screen.getByText(/Two-factor authentication is/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument());
    expect(screen.getByText("1111-2222 3333-4444")).toBeInTheDocument();
  });

  it("falls back to the full totpURI when no secret can be parsed", async () => {
    mockFetch({ totpURI: "otpauth://totp/x?issuer=MF" });
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByText("otpauth://totp/x?issuer=MF")).toBeInTheDocument());
  });

  it("shows an error when enable fails", async () => {
    mockFetch({ error: "bad_password" }, false, 401);
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't start setup — check your password"),
    );
  });

  it("verifies the code and refreshes", async () => {
    mockFetch({ totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", backupCodes: [] });
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByLabelText("Verification code")).toBeInTheDocument());
    expect(screen.queryByText(/Backup codes/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it("shows an error when verification fails", async () => {
    const fetchMock = mockFetch({ totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", backupCodes: [] });
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByLabelText("Verification code")).toBeInTheDocument());
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 400, json: async () => ({}) }) as Response);
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That code didn't verify."));
  });

  it("disables 2FA when enabled and shows an error on failure", async () => {
    mockFetch({ error: "bad_password" }, false, 401);
    render(<TwoFactorActions enabled={true} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't disable — check your password"));
  });

  it("disables 2FA successfully and refreshes", async () => {
    mockFetch(null);
    render(<TwoFactorActions enabled={true} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("SessionActions: a double revoke only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<SessionActions sessions={sessions} />);
    const btn = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SessionActions: a double sign-out-others only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<SessionActions sessions={sessions} />);
    const btn = screen.getByRole("button", { name: "Sign out all other devices" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SessionActions: a double sign-out-everywhere only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<SessionActions sessions={sessions} />);
    const btn = screen.getByRole("button", { name: "Sign out everywhere" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/login"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("SessionActions: the sign-out-everywhere button is disabled while another revoke is in flight", async () => {
    mockFetchDelayed(null);
    render(<SessionActions sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out all other devices" }));
    expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeDisabled();
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it("TwoFactorActions: an unparseable enable response still opens the setup form", async () => {
    mockFetchBadJson(true, 200);
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByLabelText("Verification code")).toBeInTheDocument());
  });

  it("TwoFactorActions: a double enable submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed({ totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", backupCodes: [] });
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    const form = screen.getByLabelText("Password").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByLabelText("Verification code")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TwoFactorActions: a double verify submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed({ totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", backupCodes: [] });
    render(<TwoFactorActions enabled={false} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor" }));
    await waitFor(() => expect(screen.getByLabelText("Verification code")).toBeInTheDocument());
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) } as Response), 200);
        }),
    );
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
    const form = screen.getByLabelText("Verification code").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    fireEvent.submit(form);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(2); // enable + one verify
  });

  it("TwoFactorActions: a double disable submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<TwoFactorActions enabled={true} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    const form = screen.getByLabelText("Password").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Disable two-factor" }));
    fireEvent.submit(form);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
