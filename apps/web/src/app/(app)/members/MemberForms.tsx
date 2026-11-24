"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

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

export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("TEAM_MEMBER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setInviteUrl("");
    const { error: err, data } = await sendJson("/api/members/invite", "POST", { email, role });
    setBusy(false);
    if (err) return setError(err);
    const d = data as { inviteUrl?: string } | null;
    setInviteUrl(d?.inviteUrl ?? "");
    setEmail("");
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="invite-email" className="mb-1 block text-xs font-medium text-zinc-500">
            Email
          </label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            required
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="mb-1 block text-xs font-medium text-zinc-500">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="TEAM_MEMBER">Team member</option>
            <option value="TEAM_ADMIN">Team admin</option>
          </select>
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "Inviting…" : "Send invite"}
        </Button>
        {error && (
          <span role="alert" className="text-xs text-red-700">
            {error}
          </span>
        )}
      </form>
      {inviteUrl && (
        <p className="text-xs text-zinc-500">
          Invite link (also emailed when SMTP is configured):{" "}
          <span className="break-all text-zinc-700 dark:text-zinc-300">{inviteUrl}</span>
        </p>
      )}
    </div>
  );
}

export function RevokeInviteButton({ inviteId }: { inviteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    setBusy(true);
    setError("");
    const { error: err } = await sendJson(`/api/members/invite/${inviteId}`, "DELETE");
    setBusy(false);
    if (err) return setError(err);
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void act()}>
        {busy ? "Revoking…" : "Revoke"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export function DeleteMemberButton({ memberId, memberEmail }: { memberId: string; memberEmail: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    if (
      !window.confirm(
        `Delete member "${memberEmail}"? Their sessions and access end immediately. This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const { error: err, data } = await sendJson(`/api/members/${memberId}`, "DELETE");
    setBusy(false);
    if (err) {
      const d = data as { details?: { connections?: number; transfers?: number } } | null;
      const blockers = d?.details
        ? ` (${d.details.connections ?? 0} connections, ${d.details.transfers ?? 0} transfers created by them)`
        : "";
      return setError(`${err}${blockers}`);
    }
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void act()}>
        {busy ? "Deleting…" : "Delete"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export function RoleSelect({
  memberId,
  role,
  canGrantSuperAdmin,
}: {
  memberId: string;
  role: string;
  canGrantSuperAdmin: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(next: string) {
    if (busy) return;
    setValue(next);
    setBusy(true);
    setError("");
    const { error: err } = await sendJson(`/api/members/${memberId}`, "PATCH", { role: next });
    setBusy(false);
    if (err) {
      setError(err);
      setValue(role);
      return;
    }
    router.refresh();
  }
  const roles = canGrantSuperAdmin ? ["SUPER_ADMIN", "TEAM_ADMIN", "TEAM_MEMBER"] : ["TEAM_ADMIN", "TEAM_MEMBER"];
  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={`role-${memberId}`} className="sr-only">
        Role
      </label>
      <select
        id={`role-${memberId}`}
        value={value}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
