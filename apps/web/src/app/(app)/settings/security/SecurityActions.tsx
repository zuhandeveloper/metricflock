"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

type SessionRow = {
  id: string;
  token: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, data };
}

export function SessionActions({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  async function revoke(token: string) {
    setBusy(token);
    await postJson("/api/auth/revoke-session", { token });
    setBusy("");
    router.refresh();
  }
  async function revokeOthers() {
    setBusy("others");
    await postJson("/api/auth/revoke-other-sessions", {});
    setBusy("");
    router.refresh();
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <p className="font-medium">
                {s.ipAddress ?? "unknown IP"}
                {s.current && <span className="ml-2 text-xs text-green-700">this device</span>}
              </p>
              <p className="max-w-md truncate text-xs text-zinc-500">{s.userAgent ?? "unknown browser"}</p>
              <p className="text-xs text-zinc-500">
                Signed in {s.createdAt.slice(0, 16).replace("T", " ")} · expires {s.expiresAt.slice(0, 10)}
              </p>
            </div>
            {!s.current && (
              <Button type="button" variant="outline" onClick={() => revoke(s.token)}>
                {busy === s.token ? "Revoking…" : "Revoke"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {sessions.length > 1 && (
        <Button type="button" variant="outline" onClick={revokeOthers}>
          {busy === "others" ? "Revoking…" : "Sign out all other devices"}
        </Button>
      )}
    </div>
  );
}

export function TwoFactorActions({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { ok, data } = await postJson("/api/auth/two-factor/enable", { password });
    setBusy(false);
    if (!ok) {
      setError("Couldn't start setup — check your password, and sign in again if your session is old.");
      return;
    }
    setSetup({
      totpURI: String(data?.totpURI ?? ""),
      backupCodes: Array.isArray(data?.backupCodes) ? (data.backupCodes as string[]) : [],
    });
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { ok } = await postJson("/api/auth/two-factor/verify-totp", { code: code.trim() });
    setBusy(false);
    if (!ok) {
      setError("That code didn't verify. Try the next code from your authenticator app.");
      return;
    }
    setSetup(null);
    router.refresh();
  }
  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { ok } = await postJson("/api/auth/two-factor/disable", { password });
    setBusy(false);
    if (!ok) {
      setError("Couldn't disable — check your password, and sign in again if your session is old.");
      return;
    }
    router.refresh();
  }

  if (enabled) {
    return (
      <form onSubmit={disable} className="space-y-3">
        <p className="text-sm">
          Two-factor authentication is <span className="font-medium text-green-700">on</span>. Enter your password to
          turn it off.
        </p>
        <div>
          <label htmlFor="2fa-disable-password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <Input
            id="2fa-disable-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <Button type="submit" variant="outline">
          {busy ? "Disabling…" : "Disable two-factor"}
        </Button>
      </form>
    );
  }

  if (setup) {
    const secret = setup.totpURI.match(/secret=([A-Z2-7]+)/i)?.[1] ?? "";
    return (
      <form onSubmit={verify} className="space-y-3">
        <p className="text-sm">
          Add this account to your authenticator app (Google Authenticator, Authy, 1Password…), then enter the 6-digit
          code to finish.
        </p>
        <div>
          <p className="text-sm font-medium">Setup key</p>
          <p className="mt-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm break-all dark:bg-zinc-800">
            {secret || setup.totpURI}
          </p>
        </div>
        {setup.backupCodes.length > 0 && (
          <div>
            <p className="text-sm font-medium">Backup codes — save these somewhere safe</p>
            <p className="mt-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm dark:bg-zinc-800">
              {setup.backupCodes.join("  ")}
            </p>
          </div>
        )}
        <div>
          <label htmlFor="2fa-verify-code" className="mb-1 block text-sm font-medium">
            Verification code
          </label>
          <Input
            id="2fa-verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <Button type="submit">{busy ? "Verifying…" : "Verify and enable"}</Button>
      </form>
    );
  }

  return (
    <form onSubmit={enable} className="space-y-3">
      <p className="text-sm">
        Two-factor authentication is <span className="font-medium">off</span>. Turn it on to require an authenticator
        code at sign-in.
      </p>
      <div>
        <label htmlFor="2fa-enable-password" className="mb-1 block text-sm font-medium">
          Password
        </label>
        <Input
          id="2fa-enable-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit">{busy ? "Starting…" : "Enable two-factor"}</Button>
    </form>
  );
}
