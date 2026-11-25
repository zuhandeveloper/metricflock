"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, Input, Button } from "@/components/ui";

export default function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (busy) return;
    setBusy(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: password, token }),
    });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError("This reset link is invalid or expired. Request a new one.");
  }
  return (
    <Card className="p-6">
      {done ? (
        <div className="space-y-3">
          <p className="text-sm">
            Your password has been reset and all existing sessions were signed out. Sign in with your new password.
          </p>
          <p className="text-sm">
            <Link href="/login" className="text-blue-600 hover:underline dark:text-blue-400">
              Go to sign in
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="reset-password" className="mb-1 block text-sm font-medium">
              New password
            </label>
            <Input
              id="reset-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              required
              autoComplete="new-password"
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">At least 12 characters.</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full justify-center" disabled={busy}>
            {busy ? "Resetting…" : "Reset password"}
          </Button>
        </form>
      )}
    </Card>
  );
}
