"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

// Organization-level admin actions (Phase 4, F-4.3): data export and
// organization deletion. Rendered only for SUPER_ADMINs; the APIs
// enforce organization.manage regardless.
export function OrgAdminActions({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [confirmSlug, setConfirmSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function deleteOrg() {
    if (busy) return;
    if (
      !window.confirm(
        "Delete this organization permanently? All teams, websites, connections and history will be removed and Google grants revoked. This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/organization", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmSlug }),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Export organization data</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Downloads a JSON archive of teams, members, websites, mappings and transfer history. Credentials and Google
          tokens are never included.
        </p>
        <a
          href="/api/organization/export"
          className="mt-2 inline-block rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Download export (JSON)
        </a>
      </div>
      <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-red-700">Delete organization</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Permanently deletes this organization and everything in it, and revokes its Google grants. Export first if you
          need an archive. Type the organization slug <strong>{orgSlug}</strong> to confirm.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="org-confirm-slug" className="mb-1 block text-xs font-medium text-zinc-500">
              Organization slug
            </label>
            <Input
              id="org-confirm-slug"
              value={confirmSlug}
              onChange={(e) => setConfirmSlug(e.target.value)}
              placeholder={orgSlug}
            />
          </div>
          <Button type="button" disabled={busy} onClick={() => void deleteOrg()}>
            {busy ? "Deleting…" : "Delete organization"}
          </Button>
          {error && (
            <span role="alert" className="text-xs text-red-700">
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
