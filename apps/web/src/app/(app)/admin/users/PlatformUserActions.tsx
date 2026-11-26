"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { roleLabel } from "./role-labels";

async function sendJson(url: string, method: string, body?: unknown): Promise<{ error: string | null; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.ok) return { error: null, data };
  return { error: data?.error ?? `request_failed_${res.status}`, data };
}

const ROLES = ["SUPER_ADMIN", "TEAM_ADMIN", "TEAM_MEMBER"];

/** Role dropdown for one user on the platform-admin page. PATCHes the
 *  platform role-change route; the platform admin's own row is rendered
 *  disabled (the API refuses self role changes anyway). */
export function PlatformRoleSelect({ userId, role, disabled }: { userId: string; role: string; disabled?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(next: string) {
    if (busy) return;
    setValue(next);
    setBusy(true);
    setError("");
    const { error: err } = await sendJson(`/api/admin/users/${userId}`, "PATCH", { role: next });
    setBusy(false);
    if (err) {
      setError(err);
      setValue(role);
      return;
    }
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={`platform-role-${userId}`} className="sr-only">
        Role
      </label>
      <select
        id={`platform-role-${userId}`}
        value={value}
        disabled={busy || disabled}
        onChange={(e) => void change(e.target.value)}
        className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
