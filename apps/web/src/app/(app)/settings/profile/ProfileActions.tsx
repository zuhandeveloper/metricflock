"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@metricflock/auth/client";
import { Button, Input } from "@/components/ui";

// Profile forms (name, set/change password). The 2FA section reuses
// TwoFactorActions from the security page. better-auth client errors
// are mapped to honest messages — raw server strings are never shown
// (same convention as the login form).

type ClientError = { status?: number; code?: string; message?: string } | null;

function clientErrorMessage(error: ClientError, fallback: string): string {
  if (error?.status === 429 || error?.code === "too_many_requests" || error?.code === "rate_limited") {
    return "Too many attempts — wait a moment and try again.";
  }
  if (error?.status === 401 || error?.code === "SESSION_NOT_FRESH" || error?.code === "UNAUTHORIZED") {
    return "Your session is too old for this change — sign in again and retry.";
  }
  if (error?.code === "INVALID_PASSWORD") return "The current password is incorrect.";
  if (error?.code === "PASSWORD_TOO_SHORT") return "Password must be at least 12 characters.";
  if (error?.code === "PASSWORD_TOO_LONG") return "Password is too long.";
  return fallback;
}

export function NameForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name cannot be empty.");
      return;
    }
    setError("");
    setSaved(false);
    setBusy(true);
    const res = await authClient.updateUser({ name: trimmed });
    setBusy(false);
    if (res?.error) {
      setError(clientErrorMessage(res.error as ClientError, "Couldn't save your name. Try again."));
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div>
        <label htmlFor="profile-name" className="mb-1 block text-sm font-medium">
          Name
        </label>
        <Input
          id="profile-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Name saved.
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save name"}
      </Button>
    </form>
  );
}

export function SetPasswordForm() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (newPassword.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError("");
    setBusy(true);
    const res = await fetch("/api/profile/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword }),
    });
    const data = (await res.json().catch(() => null)) as {
      error?: string;
      details?: { message?: string };
    } | null;
    setBusy(false);
    if (!res.ok) {
      setError(
        data?.details?.message ??
          (data?.error === "session_not_fresh"
            ? "Your session is too old for this change — sign in again and retry."
            : "Couldn't set your password. Try again."),
      );
      return;
    }
    // The page re-renders with hasPassword=true (change-password form).
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm">
        You signed in with Google, so this account has no password yet. Set one to also sign in with email + password.
      </p>
      <div>
        <label htmlFor="profile-new-password" className="mb-1 block text-sm font-medium">
          New password
        </label>
        <Input
          id="profile-new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={12}
          autoComplete="new-password"
        />
      </div>
      <div>
        <label htmlFor="profile-confirm-password" className="mb-1 block text-sm font-medium">
          Confirm password
        </label>
        <Input
          id="profile-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={12}
          autoComplete="new-password"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Setting…" : "Set password"}
      </Button>
    </form>
  );
}

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (newPassword.length < 12) {
      setError("Password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError("");
    setSaved(false);
    setBusy(true);
    const res = await authClient.changePassword({ currentPassword, newPassword });
    setBusy(false);
    if (res?.error) {
      setError(clientErrorMessage(res.error as ClientError, "Couldn't change your password. Try again."));
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label htmlFor="profile-current-password" className="mb-1 block text-sm font-medium">
          Current password
        </label>
        <Input
          id="profile-current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>
      <div>
        <label htmlFor="profile-change-new-password" className="mb-1 block text-sm font-medium">
          New password
        </label>
        <Input
          id="profile-change-new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={12}
          autoComplete="new-password"
        />
      </div>
      <div>
        <label htmlFor="profile-change-confirm-password" className="mb-1 block text-sm font-medium">
          Confirm password
        </label>
        <Input
          id="profile-change-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={12}
          autoComplete="new-password"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-green-700 dark:text-green-400">
          Password changed.
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
