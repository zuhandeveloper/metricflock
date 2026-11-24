// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ResetPasswordForm from "@/app/reset-password/[token]/ResetPasswordForm";
import ForgotPasswordForm from "@/app/forgot-password/ForgotPasswordForm";
import { AcceptInviteButton } from "@/app/invite/[token]/AcceptInviteButton";
import { RequeueButton } from "@/app/(app)/sync/RequeueButton";
import { mockFetch, mockFetchBadJson, mockFetchDelayed } from "./helpers";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  pathname: "/",
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResetPasswordForm", () => {
  it("rejects passwords shorter than 12 characters without calling the API", () => {
    const fetchMock = mockFetch(null);
    render(<ResetPasswordForm token="tok1" />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Password must be at least 12 characters.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resets the password and shows the done state with a sign-in link", async () => {
    const fetchMock = mockFetch(null);
    render(<ResetPasswordForm token="tok1" />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-very-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(screen.getByText(/Your password has been reset/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/reset-password",
      expect.objectContaining({
        body: JSON.stringify({ newPassword: "a-very-long-password", token: "tok1" }),
      }),
    );
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it("shows the invalid-link error when the reset fails", async () => {
    mockFetch({ error: "invalid" }, false, 400);
    render(<ResetPasswordForm token="tok1" />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-very-long-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This reset link is invalid or expired."));
  });
});

describe("ForgotPasswordForm", () => {
  it("sends the reset request and shows the sent state with the email", async () => {
    const fetchMock = mockFetch(null);
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(screen.getByText(/a password reset link is on its way/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/request-password-reset",
      expect.objectContaining({
        body: JSON.stringify({ email: "a@example.com", redirectTo: "/reset-password" }),
      }),
    );
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });

  it("still shows the sent state when the request itself fails (no enumeration)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(screen.getByText(/a password reset link is on its way/)).toBeInTheDocument());
  });
});

describe("AcceptInviteButton", () => {
  it("accepts the invite and navigates to /dashboard", async () => {
    const fetchMock = mockFetch(null);
    render(<AcceptInviteButton token="inv-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invites/accept",
      expect.objectContaining({ body: JSON.stringify({ token: "inv-token" }) }),
    );
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "invite_expired" }, false, 410);
    render(<AcceptInviteButton token="inv-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invite_expired"));
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("falls back to request_failed_<status> when the error body is empty", async () => {
    mockFetch(null, false, 500);
    render(<AcceptInviteButton token="inv-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });
});

describe("RequeueButton", () => {
  it("requeues the job and refreshes", async () => {
    const fetchMock = mockFetch(null);
    render(<RequeueButton jobId="job1" />);
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sync/requeue",
      expect.objectContaining({ body: JSON.stringify({ jobId: "job1" }) }),
    );
  });

  it("shows the server error on failure", async () => {
    mockFetch({ error: "queue_unavailable" }, false, 503);
    render(<RequeueButton jobId="job1" />);
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("queue_unavailable"));
  });

  it("disables the button while requeueing", async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => null } as Response), 200);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<RequeueButton jobId="job1" />);
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Requeueing…" })).toBeDisabled());
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe("gap closure: json parse failures and busy guards", () => {
  it("ResetPasswordForm: a double submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<ResetPasswordForm token="tok1" />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-very-long-password" } });
    const form = screen.getByLabelText("New password").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/Your password has been reset/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ForgotPasswordForm: a double submit only posts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    const form = screen.getByLabelText("Email").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/a password reset link is on its way/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("AcceptInviteButton: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<AcceptInviteButton token="inv-token" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("AcceptInviteButton: a double click only accepts once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<AcceptInviteButton token="inv-token" />);
    const btn = screen.getByRole("button", { name: "Accept invite" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("RequeueButton: an unparseable error body falls back to request_failed", async () => {
    mockFetchBadJson(false, 500);
    render(<RequeueButton jobId="job1" />);
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("request_failed_500"));
  });

  it("RequeueButton: a double click only requeues once (busy guard)", async () => {
    const fetchMock = mockFetchDelayed(null);
    render(<RequeueButton jobId="job1" />);
    const btn = screen.getByRole("button", { name: "Requeue" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
