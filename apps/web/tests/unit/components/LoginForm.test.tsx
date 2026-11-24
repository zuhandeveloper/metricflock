// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LoginForm from "@/app/login/LoginForm";
import { mockFetch, mockFetchBadJson, mockFetchDelayed, mockLocationAssign } from "./helpers";

const auth = vi.hoisted(() => ({ social: vi.fn() }));
vi.mock("@metricflock/auth/client", () => ({
  signIn: { social: auth.social },
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

describe("LoginForm", () => {
  it("signs in with email and redirects to /dashboard", async () => {
    const assign = mockLocationAssign();
    const fetchMock = mockFetch({ status: "ok" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ body: JSON.stringify({ email: "a@example.com", password: "pw1234567890" }) }),
    );
  });

  it("shows an error on bad credentials", async () => {
    mockLocationAssign();
    mockFetch({ error: "invalid" }, false, 401);
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password."));
  });

  it("switches to the 2FA code form when the server requires it", async () => {
    const assign = mockLocationAssign();
    const fetchMock = mockFetch({ status: "two_factor_required" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Two-factor code")).toBeInTheDocument());
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
  });

  it("shows an error when the 2FA code is rejected", async () => {
    mockLocationAssign();
    const fetchMock = mockFetch({ status: "two_factor_required" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Two-factor code")).toBeInTheDocument());
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That code didn't work."));
  });

  it("starts Google sign-in and shows an error when it fails", async () => {
    auth.social.mockResolvedValueOnce({ error: { message: "boom" } });
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in is not available right now."),
    );
    expect(auth.social).toHaveBeenCalledWith({ provider: "google", callbackURL: "/dashboard" });
  });

  it("does nothing extra on Google sign-in success (better-auth redirects)", async () => {
    auth.social.mockResolvedValueOnce({});
    render(<LoginForm />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(auth.social).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeDisabled();
  });

  it("links to forgot-password", () => {
    render(<LoginForm />);
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/forgot-password");
  });
});

describe("gap closure: json parse failure and busy guards", () => {
  it("an unparseable login response still redirects (json falls back to null)", async () => {
    const assign = mockLocationAssign();
    mockFetchBadJson(true, 200);
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
  });

  it("a double Google click only starts one sign-in (busy guard)", async () => {
    auth.social.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({}), 200);
        }),
    );
    render(<LoginForm />);
    const btn = screen.getByRole("button", { name: "Continue with Google" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(auth.social).toHaveBeenCalledTimes(1));
  });

  it("a double email submit only posts once (busy guard)", async () => {
    mockLocationAssign();
    const fetchMock = mockFetchDelayed({ status: "ok" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    const form = screen.getByLabelText("Email").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("a double 2FA submit only posts once (busy guard)", async () => {
    const assign = mockLocationAssign();
    const fetchMock = mockFetchDelayed({ status: "two_factor_required" });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByLabelText("Two-factor code")).toBeInTheDocument());
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({}) } as Response), 200);
        }),
    );
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    const form = screen.getByLabelText("Two-factor code").closest("form")!;
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    fireEvent.submit(form);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + one verify
  });
});
