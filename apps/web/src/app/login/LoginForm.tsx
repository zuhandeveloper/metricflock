"use client";
import { useState } from "react";
import Link from "next/link";
import { signIn } from "@metricflock/auth/client";
import { Card, Input, Button } from "@/components/ui";
const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in a few minutes.";
const SERVER_ERROR = "Something went wrong on our side. Try again in a moment.";

/** Map an HTTP failure to the message the user should see (A-FE-05).
 * Status wins, but the API's error code is read too — a `rate_limited` /
 * `too_many_requests` code maps to the 429 message even if the status is
 * ambiguous. `fallback` is the message for an ordinary client-side
 * rejection (wrong password / wrong 2FA code). Raw server error strings
 * are never surfaced to the user. */
function authErrorMessage(status: number, body: { error?: string } | null, fallback: string): string {
  const code = body?.error ?? "";
  if (status === 429 || code === "too_many_requests" || code === "rate_limited") return TOO_MANY_ATTEMPTS;
  if (status >= 500 || code === "internal_error" || code === "server_error") return SERVER_ERROR;
  return fallback;
}

/** Same mapping for better-auth's `signIn.social` error object, which
 * carries `status` / `code` instead of an HTTP response. */
function socialErrorMessage(error: { status?: number; code?: string } | null): string {
  if (error?.status === 429 || error?.code === "too_many_requests" || error?.code === "rate_limited")
    return TOO_MANY_ATTEMPTS;
  return "Google sign-in is not available right now. Use email instead.";
}

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function google() {
    if (busy) return;
    setError("");
    setBusy(true);
    const res = await signIn.social({ provider: "google", callbackURL: "/dashboard" });
    if (res?.error) {
      setBusy(false);
      setError(socialErrorMessage(res.error as { status?: number; code?: string } | null));
    }
    // On success better-auth redirects the browser to Google's consent screen.
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { status?: string } | null;
      if (data?.status === "two_factor_required") {
        setBusy(false);
        setNeedsTwoFactor(true);
        return;
      }
      window.location.assign("/dashboard");
    } else {
      setBusy(false);
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(authErrorMessage(res.status, body, "Invalid email or password."));
    }
  }
  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    const res = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    if (res.ok) window.location.assign("/dashboard");
    else {
      setBusy(false);
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(
        authErrorMessage(res.status, body, "That code didn't work. Check your authenticator app and try again."),
      );
    }
  }
  if (needsTwoFactor) {
    return (
      <Card className="p-6">
        <form onSubmit={submitCode} className="space-y-3">
          <div>
            <label htmlFor="login-2fa-code" className="mb-1 block text-sm font-medium">
              Two-factor code
            </label>
            <Input
              id="login-2fa-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full justify-center" disabled={busy}>
            {busy ? "Verifying…" : "Verify and sign in"}
          </Button>
        </form>
      </Card>
    );
  }
  return (
    <Card className="p-6">
      <Button type="button" variant="outline" className="w-full justify-center" disabled={busy} onClick={google}>
        Continue with Google
      </Button>
      <div className="my-4 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or continue with email
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-medium">
            Email
          </label>
          <Input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
            autoComplete="email"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            autoComplete="current-password"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full justify-center" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-sm">
          <Link href="/forgot-password" className="text-blue-600 hover:underline dark:text-blue-400">
            Forgot your password?
          </Link>
        </p>
      </form>
    </Card>
  );
}
