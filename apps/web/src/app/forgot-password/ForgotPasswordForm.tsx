"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, Input, Button } from "@/components/ui";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    // better-auth always returns 200 here (no account enumeration); the
    // reset email is only sent when the account exists. A transport
    // failure (offline, server down) is NOT that 200 — it must surface
    // an error instead of telling the user to wait for an email that
    // will never arrive. Non-2xx responses (validation, rate limit,
    // server error) don't depend on whether the account exists, so
    // showing the error leaks nothing.
    try {
      const res = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, redirectTo: "/reset-password" }),
      });
      if (res.ok) setSent(true);
      else setError("Couldn't reach the server — check your connection and try again.");
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
    }
    setBusy(false);
  }
  return (
    <Card className="p-6">
      {sent ? (
        <div className="space-y-3">
          <p className="text-sm">
            If an account exists for <span className="font-medium">{email}</span>, a password reset link is on its way.
            The link expires soon and can be used once.
          </p>
          <p className="text-sm">
            <Link href="/login" className="text-blue-600 hover:underline dark:text-blue-400">
              Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="forgot-email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <Input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              autoComplete="email"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full justify-center" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
          <p className="text-center text-sm">
            <Link href="/login" className="text-blue-600 hover:underline dark:text-blue-400">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </Card>
  );
}
