"use client";
import { useState } from "react";
import Link from "next/link";

// A-SEC-08: non-blocking recommendation shown to signed-in users who
// are not SUPER_ADMIN and have not enabled two-factor authentication
// (owner decision 2026-11-26: mandatory for SUPER_ADMIN, recommended
// for everyone else). Dismissal is per-mount state — the (app) layout
// persists across client navigations, so dismissing hides it for the
// rest of the session; a full reload shows it again.
export default function TwoFactorNudge() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      role="note"
      className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <p>
        Two-factor authentication is off for your account. We recommend turning it on —{" "}
        <Link href="/settings/security" className="font-medium underline underline-offset-2">
          set it up in Settings → Security
        </Link>
        .
      </p>
      <button
        type="button"
        aria-label="Dismiss two-factor recommendation"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-md px-2 py-0.5 font-medium hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-amber-900/50"
      >
        Dismiss
      </button>
    </div>
  );
}
