"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

async function sendJson(url: string, body: unknown): Promise<{ error: string | null; data: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.ok) return { error: null, data };
  return { error: data?.error ?? `request_failed_${res.status}`, data };
}

export function DisconnectButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    if (!window.confirm("Disconnect this Google account? Mapped properties will stop syncing.")) return;
    setBusy(true);
    setError("");
    const { error: err } = await sendJson("/api/google/connections/disconnect", { connectionId });
    setBusy(false);
    if (err) return setError(err);
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void act()}>
        {busy ? "Disconnecting…" : "Disconnect"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export function DiscoverButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [providerErrors, setProviderErrors] = useState<string[]>([]);
  async function act() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSummary("");
    setProviderErrors([]);
    const { error: err, data } = await sendJson("/api/google/properties/discover", { connectionId });
    setBusy(false);
    if (err) return setError(err);
    const d = data as {
      ga4?: unknown[];
      searchConsole?: unknown[];
      adsense?: unknown[];
      adManager?: unknown[];
      errors?: Record<string, string>;
    } | null;
    // A-GGL-10: the Ad Manager segment appears only when the response
    // carries it (Ad Manager disabled → no key), so a disabled setup
    // never prints a misleading "0 Ad Manager".
    setSummary(
      `Found ${d?.ga4?.length ?? 0} GA4, ${d?.searchConsole?.length ?? 0} Search Console, ${d?.adsense?.length ?? 0} AdSense${d?.adManager !== undefined ? `, ${d.adManager.length} Ad Manager` : ""}.`,
    );
    const hints: Record<string, string> = {
      api_not_enabled: "API not enabled in Google Cloud Console",
      permission_denied: "permission denied for this Google account",
      unauthorized: "reconnect the Google account",
      provider_error: "provider error (check server logs)",
    };
    const labels: Record<string, string> = {
      ga4: "GA4",
      searchConsole: "Search Console",
      adsense: "AdSense",
      adManager: "Ad Manager",
    };
    setProviderErrors(Object.entries(d?.errors ?? {}).map(([k, v]) => `${labels[k] ?? k}: ${hints[v] ?? v}`));
    router.refresh();
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void act()}>
        {busy ? "Discovering…" : "Discover properties"}
      </Button>
      {summary && <span className="text-xs text-emerald-700">{summary}</span>}
      {providerErrors.map((e) => (
        <span key={e} role="alert" className="text-xs text-amber-700">
          {e}
        </span>
      ))}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

export type WebsiteOption = { id: string; name: string };

export function MapPropertyForm({
  provider,
  externalId,
  resourceName,
  connectionId,
  websites,
  mappedTo,
  // A-FE-03: the page caps the website options at 20 and narrows them
  // with its search — when a search matches nothing, say so instead of
  // claiming no website exists at all. Defaults to the old message.
  emptyMessage,
}: {
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
  externalId: string;
  resourceName?: string;
  connectionId: string;
  websites: WebsiteOption[];
  mappedTo?: string | null;
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [websiteId, setWebsiteId] = useState(websites[0]?.id ?? "");
  const [isPrimary, setIsPrimary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  if (websites.length === 0) {
    return <span className="text-xs text-zinc-500">{emptyMessage ?? "Add a website first to map this property."}</span>;
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const { error: err } = await sendJson("/api/google/properties/map", {
      websiteId,
      provider,
      externalId,
      connectionId,
      ...(resourceName ? { resourceName } : {}),
      isPrimary,
    });
    setBusy(false);
    if (err) return setError(err);
    setDone(true);
    router.refresh();
  }
  const selectId = `map-${provider}-${externalId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      {mappedTo && <span className="text-xs text-zinc-500">Mapped to: {mappedTo}</span>}
      <label htmlFor={selectId} className="sr-only">
        Website for {externalId}
      </label>
      <select
        id={selectId}
        value={websiteId}
        onChange={(e) => setWebsiteId(e.target.value)}
        required
        className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
      >
        {websites.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
        Primary
      </label>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? "Mapping…" : "Map"}
      </Button>
      {done && <span className="text-xs text-emerald-700">Mapped.</span>}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}
