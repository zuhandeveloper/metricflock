"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function postJson(url: string, method: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `request_failed_${res.status}`;
}

export function DeleteTeamButton({ teamId, teamName }: { teamId: string; teamName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (!window.confirm(`Delete team "${teamName}"? Its members and team-level Google connections will be removed.`))
      return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/teams/${teamId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; websites?: number } | null;
      setError(
        data?.error === "team_has_websites"
          ? `team_has_websites (${data.websites} website(s) — move or delete them first)`
          : (data?.error ?? `request_failed_${res.status}`),
      );
      return;
    }
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" onClick={() => void act()}>
        {busy ? "Deleting…" : "Delete team"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export function CreateTeamForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const err = await postJson("/api/teams", "POST", { name, slug: slug || slugify(name) });
    setBusy(false);
    if (err) return setError(err);
    setName("");
    setSlug("");
    setSlugTouched(false);
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="team-name" className="mb-1 block text-xs font-medium text-zinc-500">
          Team name
        </label>
        <Input
          id="team-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          placeholder="e.g. Content Sites"
          required
        />
      </div>
      <div>
        <label htmlFor="team-slug" className="mb-1 block text-xs font-medium text-zinc-500">
          Slug
        </label>
        <Input
          id="team-slug"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugTouched(true);
          }}
          placeholder="content-sites"
          pattern="[a-z0-9-]+"
          required
        />
      </div>
      <Button type="submit">{busy ? "Creating…" : "Create team"}</Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}

export type TeamMemberRow = { userId: string; email: string; role: string; isAdmin: boolean };
export type OrgUser = { id: string; email: string; role: string };

export function TeamAdminControls({
  teamId,
  teamName,
  members,
  orgUsers,
}: {
  teamId: string;
  teamName: string;
  members: TeamMemberRow[];
  orgUsers: OrgUser[];
}) {
  const router = useRouter();
  const [name, setName] = useState(teamName);
  const [addUserId, setAddUserId] = useState("");
  const [addAdmin, setAddAdmin] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = orgUsers.filter((u) => !memberIds.has(u.id));

  async function run(key: string, url: string, method: string, body: unknown) {
    setBusy(key);
    setError("");
    const err = await postJson(url, method, body);
    setBusy("");
    if (err) return setError(err);
    router.refresh();
  }

  return (
    <div className="mt-3 space-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run("rename", `/api/teams/${teamId}`, "PATCH", { name });
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div>
          <label htmlFor={`rename-${teamId}`} className="mb-1 block text-xs font-medium text-zinc-500">
            Rename team
          </label>
          <Input id={`rename-${teamId}`} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <Button type="submit" variant="outline">
          {busy === "rename" ? "Saving…" : "Rename"}
        </Button>
      </form>

      <ul className="space-y-1 text-sm">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-2">
            <span>
              {m.email} · {m.role}
              {m.isAdmin ? " (team admin)" : ""}
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void run(`admin-${m.userId}`, `/api/teams/${teamId}/members`, "POST", {
                  userId: m.userId,
                  isAdmin: !m.isAdmin,
                  action: "add",
                })
              }
            >
              {m.isAdmin ? "Remove admin" : "Make admin"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                void run(`remove-${m.userId}`, `/api/teams/${teamId}/members`, "POST", {
                  userId: m.userId,
                  action: "remove",
                })
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>

      {candidates.length > 0 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!addUserId) return;
            void run("add", `/api/teams/${teamId}/members`, "POST", {
              userId: addUserId,
              isAdmin: addAdmin,
              action: "add",
            });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div>
            <label htmlFor={`add-member-${teamId}`} className="mb-1 block text-xs font-medium text-zinc-500">
              Add member
            </label>
            <select
              id={`add-member-${teamId}`}
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value)}
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
          <label className="flex items-center gap-1.5 pb-2 text-sm">
            <input type="checkbox" checked={addAdmin} onChange={(e) => setAddAdmin(e.target.checked)} />
            Team admin
          </label>
          <Button type="submit" variant="outline">
            {busy === "add" ? "Adding…" : "Add"}
          </Button>
        </form>
      ) : (
        <p className="text-xs text-zinc-500">All organization users are already in this team.</p>
      )}
      <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <DeleteTeamButton teamId={teamId} teamName={teamName} />
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
