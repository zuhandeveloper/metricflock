"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { qrSvgPath } from "@/lib/qr";

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
  const [error, setError] = useState("");
  async function revoke(token: string) {
    if (busy) return;
    setError("");
    setBusy(token);
    const { ok } = await postJson("/api/auth/revoke-session", { token });
    setBusy("");
    // A-FE-10: a failed revoke must not look successful — surface the
    // error and leave the list as-is instead of refreshing.
    if (!ok) {
      setError("Couldn't revoke that session. Try again.");
      return;
    }
    router.refresh();
  }
  async function revokeOthers() {
    if (busy) return;
    // A-FE-10: confirm before signing out every other device.
    if (!window.confirm("Sign out all other devices? They will need to sign in again.")) return;
    setError("");
    setBusy("others");
    const { ok } = await postJson("/api/auth/revoke-other-sessions", {});
    setBusy("");
    if (!ok) {
      setError("Couldn't sign out other devices. Try again.");
      return;
    }
    router.refresh();
  }
  async function revokeAll() {
    if (busy) return;
    setError("");
    setBusy("all");
    const { ok } = await postJson("/api/auth/revoke-sessions", {});
    setBusy("");
    if (!ok) {
      setError("Couldn't sign out everywhere. Try again.");
      return;
    }
    router.push("/login");
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
              <p className="max-w-md truncate text-xs text-zinc-500 dark:text-zinc-400">
                {s.userAgent ?? "unknown browser"}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Signed in {s.createdAt.slice(0, 16).replace("T", " ")} · expires {s.expiresAt.slice(0, 10)}
              </p>
            </div>
            {!s.current && (
              <Button type="button" variant="outline" disabled={busy !== ""} onClick={() => revoke(s.token)}>
                {busy === s.token ? "Revoking…" : "Revoke"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {sessions.length > 1 && (
          <Button type="button" variant="outline" disabled={busy !== ""} onClick={revokeOthers}>
            {busy === "others" ? "Revoking…" : "Sign out all other devices"}
          </Button>
        )}
        <Button type="button" variant="outline" disabled={busy !== ""} onClick={revokeAll}>
          {busy === "all" ? "Signing out…" : "Sign out everywhere"}
        </Button>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Sign out everywhere ends every session, including this device.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
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
  // A-FE-08: scannable QR code for the totpURI, shown next to the manual
  // setup key. Null when there is no setup in progress or the URI cannot
  // be encoded — the manual key below remains the fallback.
  const qr = useMemo(() => {
    if (!setup?.totpURI) return null;
    try {
      return qrSvgPath(setup.totpURI);
    } catch {
      return null;
    }
  }, [setup?.totpURI]);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
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
    if (busy) return;
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
    if (busy) return;
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
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" variant="outline" disabled={busy}>
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
        {qr && (
          <div>
            <p className="text-sm font-medium">Scan with your authenticator app</p>
            <svg
              role="img"
              aria-label="QR code for two-factor setup"
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              className="mt-1 h-44 w-44 rounded-lg border border-zinc-200 dark:border-zinc-700"
              shapeRendering="crispEdges"
            >
              <rect width={qr.size} height={qr.size} fill="#ffffff" />
              <path d={qr.path} fill="#000000" />
            </svg>
          </div>
        )}
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
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Verifying…" : "Verify and enable"}
        </Button>
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
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Starting…" : "Enable two-factor"}
      </Button>
    </form>
  );
}
