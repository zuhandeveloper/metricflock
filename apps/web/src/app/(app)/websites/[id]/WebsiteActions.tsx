"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

async function sendJson(url: string, method: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `request_failed_${res.status}`;
}

function ErrorText({ error }: { error: string }) {
  if (!error) return null;
  return (
    <span role="alert" className="text-xs text-red-700 dark:text-red-400">
      {error}
    </span>
  );
}

export type TeamOption = { id: string; name: string };
export type OrgUser = { id: string; email: string; role: string };
export type AssignmentRow = { userId: string; email: string };

export function EditWebsiteForm({
  websiteId,
  name: initialName,
  domain: initialDomain,
  url: initialUrl,
  status: initialStatus,
  teamId: initialTeamId,
  teams,
}: {
  websiteId: string;
  name: string;
  domain: string;
  url: string;
  status: string;
  teamId: string | null;
  teams: TeamOption[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [domain, setDomain] = useState(initialDomain);
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState(initialStatus);
  const [teamId, setTeamId] = useState(initialTeamId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    const err = await sendJson(`/api/websites/${websiteId}`, "PATCH", {
      name,
      domain,
      url,
      status,
      ...(teamId ? { teamId } : {}),
    });
    setBusy(false);
    if (err) return setError(err);
    setSaved(true);
    router.refresh();
  }
  const selectCls =
    "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="edit-name" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Name
        </label>
        <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="edit-domain" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Domain
        </label>
        <Input id="edit-domain" value={domain} onChange={(e) => setDomain(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="edit-url" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          URL
        </label>
        <Input id="edit-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="edit-status" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Status
        </label>
        <select id="edit-status" value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
          {["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "ARCHIVED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="edit-team" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Team
        </label>
        <select id="edit-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} className={selectCls}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? "Saving…" : "Save changes"}
      </Button>
      {saved && <span className="text-xs text-emerald-700 dark:text-emerald-400">Saved.</span>}
      <ErrorText error={error} />
    </form>
  );
}

export function DeleteWebsiteButton({ websiteId, domain }: { websiteId: string; domain: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    if (
      !window.confirm(
        `Delete website ${domain}? Its integrations, assignments, transfers and sync history will be removed.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/websites/${websiteId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `request_failed_${res.status}`);
      return;
    }
    router.push("/websites");
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void act()}>
        {busy ? "Deleting…" : "Delete website"}
      </Button>
      <ErrorText error={error} />
    </span>
  );
}

export function AssignForm({
  websiteId,
  assignments,
  orgUsers,
}: {
  websiteId: string;
  assignments: AssignmentRow[];
  orgUsers: OrgUser[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const assignedIds = new Set(assignments.map((a) => a.userId));
  const candidates = orgUsers.filter((u) => !assignedIds.has(u.id));
  async function run(key: string, body: unknown) {
    if (busy) return;
    setBusy(key);
    setError("");
    const err = await sendJson(`/api/websites/${websiteId}/assign`, "POST", body);
    setBusy("");
    if (err) return setError(err);
    router.refresh();
  }
  return (
    <div className="space-y-2">
      {assignments.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No members assigned to this website.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {assignments.map((a) => (
            <li key={a.userId} className="flex flex-wrap items-center gap-2">
              <span>{a.email}</span>
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== ""}
                onClick={() => void run(a.userId, { userId: a.userId, action: "remove" })}
              >
                {busy === a.userId ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (userId) void run("assign", { userId, action: "assign" });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div>
            <label htmlFor="assign-user" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Assign member
            </label>
            <select
              id="assign-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">Select user…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.role})
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="outline" disabled={busy !== ""}>
            {busy === "assign" ? "Assigning…" : "Assign"}
          </Button>
        </form>
      )}
      <ErrorText error={error} />
    </div>
  );
}

export function TransferForm({
  websiteId,
  currentTeamId,
  teams,
}: {
  websiteId: string;
  currentTeamId: string | null;
  teams: TeamOption[];
}) {
  const router = useRouter();
  const targets = teams.filter((t) => t.id !== currentTeamId);
  const [toTeamId, setToTeamId] = useState(targets[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  if (targets.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No other team to transfer to. Create another team first.
      </p>
    );
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const err = await sendJson(`/api/websites/${websiteId}/transfer`, "POST", {
      toTeamId,
      ...(reason ? { reason } : {}),
    });
    setBusy(false);
    if (err) return setError(err);
    setDone(true);
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="transfer-team" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Destination team
        </label>
        <select
          id="transfer-team"
          value={toTeamId}
          onChange={(e) => setToTeamId(e.target.value)}
          required
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        >
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="transfer-reason" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Reason (optional)
        </label>
        <Input id="transfer-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? "Starting…" : "Start transfer"}
      </Button>
      {done && (
        <span className="text-xs text-emerald-700 dark:text-emerald-400">
          Transfer started — destination team must accept.
        </span>
      )}
      <ErrorText error={error} />
    </form>
  );
}

const SYNC_TYPES = [
  { value: "ga4-realtime-sync", label: "GA4 realtime" },
  { value: "ga4-historical-sync", label: "GA4 historical" },
  { value: "search-console-sync", label: "Search Console" },
  { value: "adsense-sync", label: "AdSense" },
  { value: "ad-manager-sync", label: "Ad Manager" },
  { value: "analytics-cache-refresh", label: "Cache refresh" },
  { value: "integration-health-check", label: "Health check" },
] as const;

export function SyncNowForm({ websiteId }: { websiteId: string }) {
  const router = useRouter();
  const [type, setType] = useState<string>("ga4-historical-sync");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [note, setNote] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setDone(false);
    setNote("");
    // A-API-06: read the response body — a duplicate click in the same
    // hour returns 200 already_queued / already_completed, not an error.
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ websiteId, type }),
    });
    setBusy(false);
    const data = (await res.json().catch(() => null)) as { error?: string; status?: string } | null;
    if (!res.ok) {
      return setError(
        data?.error === "queue_unavailable"
          ? "queue_unavailable (worker/Redis not running)"
          : (data?.error ?? `request_failed_${res.status}`),
      );
    }
    if (data?.status === "already_queued") return setNote("Already queued for this hour.");
    if (data?.status === "already_completed") return setNote("Already synced this hour.");
    setDone(true);
    // A-FE-07: the page shows the latest sync job above this form — refresh
    // so the row just created (PENDING) appears instead of the previous one.
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="sync-type" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Sync type
        </label>
        <select
          id="sync-type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        >
          {SYNC_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? "Queueing…" : "Sync now"}
      </Button>
      {done && <span className="text-xs text-emerald-700 dark:text-emerald-400">Queued.</span>}
      {note && <span className="text-xs text-zinc-500 dark:text-zinc-400">{note}</span>}
      <ErrorText error={error} />
    </form>
  );
}
