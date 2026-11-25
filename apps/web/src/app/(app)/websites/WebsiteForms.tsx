"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

export type TeamOption = { id: string; name: string };

export function AddWebsiteForm({ teams }: { teams: TeamOption[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (teams.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Create a team first (Teams page) — every website belongs to a team.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/websites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, domain, url: url || `https://${domain}`, teamId }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `request_failed_${res.status}`);
      return;
    }
    setName("");
    setDomain("");
    setUrl("");
    setUrlTouched(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor="site-name" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Website name
        </label>
        <Input id="site-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Blog" required />
      </div>
      <div>
        <label htmlFor="site-domain" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Domain
        </label>
        <Input
          id="site-domain"
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value);
            if (!urlTouched) setUrl(e.target.value ? `https://${e.target.value}` : "");
          }}
          placeholder="example.com"
          required
        />
      </div>
      <div>
        <label htmlFor="site-url" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          URL
        </label>
        <Input
          id="site-url"
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlTouched(true);
          }}
          placeholder="https://example.com"
          required
        />
      </div>
      <div>
        <label htmlFor="site-team" className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
          Team
        </label>
        <select
          id="site-team"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          required
          className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add website"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {error}
        </span>
      )}
    </form>
  );
}
