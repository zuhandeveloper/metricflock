"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@/components/ui";

// A-SEC-09 — the v1 read scopes. Mirrors API_KEY_SCOPES in
// @metricflock/shared (not imported here: the shared barrel pulls
// in node:crypto, which cannot ship to the browser). The server
// validates scopes on create, so drift here can only hide a
// checkbox, never widen access.
const SCOPES = [
  { scope: "websites:read", label: "Websites" },
  { scope: "portfolio:read", label: "Portfolio" },
  { scope: "insights:read", label: "Insights" },
  { scope: "health:read", label: "Health" },
] as const;

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  scopes: string[];
  createdAt: string;
};

function isExpired(k: KeyRow): boolean {
  return !k.revokedAt && !!k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now();
}

export function ApiKeyManager({ initial }: { initial: KeyRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(SCOPES.map((s) => s.scope));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newSecret, setNewSecret] = useState("");

  function toggleScope(scope: string) {
    setSelectedScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    setNewSecret("");
    // All four scopes checked = full access; send an empty list so
    // the key stays a legacy-style full-access key.
    const scopes = selectedScopes.length === SCOPES.length ? [] : selectedScopes;
    const days = expiryDays.trim() === "" ? null : Number(expiryDays);
    const body: { name: string; expiresAt?: string; scopes: string[] } = { name: name.trim(), scopes };
    if (days !== null && Number.isFinite(days))
      body.expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { secret?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    setNewSecret(data?.secret ?? "");
    setName("");
    setExpiryDays("");
    setSelectedScopes(SCOPES.map((s) => s.scope));
    router.refresh();
  }

  async function revoke(id: string) {
    if (busy) return;
    if (!window.confirm("Revoke this API key? Anything using it will stop working immediately.")) return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    router.refresh();
  }

  async function rotate(id: string) {
    if (busy) return;
    if (!window.confirm("Rotate this API key? The old secret stops working immediately and a new one is shown once."))
      return;
    setBusy(true);
    setError("");
    setNewSecret("");
    const res = await fetch(`/api/api-keys/${id}/rotate`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as { secret?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    setNewSecret(data?.secret ?? "");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="api-key-name" className="mb-1 block text-xs font-medium text-zinc-500">
            Key name (e.g. &quot;Reporting script&quot;)
          </label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My integration"
          />
        </div>
        <div>
          <label htmlFor="api-key-expiry-days" className="mb-1 block text-xs font-medium text-zinc-500">
            Expires in days (optional, max 365)
          </label>
          <Input
            id="api-key-expiry-days"
            type="number"
            min={1}
            max={365}
            value={expiryDays}
            onChange={(e) => setExpiryDays(e.target.value)}
            placeholder="Never"
          />
        </div>
        <Button onClick={create} disabled={busy}>
          Create API key
        </Button>
      </div>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-zinc-500">Scopes (all checked = full access)</legend>
        <div className="flex flex-wrap gap-3">
          {SCOPES.map((s) => (
            <label key={s.scope} className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={selectedScopes.includes(s.scope)} onChange={() => toggleScope(s.scope)} />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      {newSecret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
          <p className="font-semibold">Copy this secret now — it will not be shown again:</p>
          <code className="mt-1 block break-all">{newSecret}</code>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {initial.length === 0 ? (
        <p className="text-sm text-zinc-500">No API keys yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th scope="col" className="py-1 pr-2">
                Name
              </th>
              <th scope="col" className="py-1 pr-2">
                Key
              </th>
              <th scope="col" className="py-1 pr-2">
                Created
              </th>
              <th scope="col" className="py-1 pr-2">
                Last used
              </th>
              <th scope="col" className="py-1 pr-2">
                Expires
              </th>
              <th scope="col" className="py-1 pr-2">
                Scopes
              </th>
              <th scope="col" className="py-1 pr-2">
                Status
              </th>
              <th scope="col" className="py-1" />
            </tr>
          </thead>
          <tbody>
            {initial.map((k) => (
              <tr key={k.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-1 pr-2">{k.name}</td>
                <td className="py-1 pr-2">
                  <code>{k.prefix}…</code>
                </td>
                <td className="py-1 pr-2">{new Date(k.createdAt).toLocaleDateString()}</td>
                <td className="py-1 pr-2">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—"}</td>
                <td className="py-1 pr-2">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"}</td>
                <td className="py-1 pr-2">{k.scopes.length === 0 ? "All" : k.scopes.join(", ")}</td>
                <td className="py-1 pr-2">
                  {k.revokedAt ? (
                    <Badge tone="red">Revoked</Badge>
                  ) : isExpired(k) ? (
                    <Badge tone="red">Expired</Badge>
                  ) : (
                    <Badge tone="green">Active</Badge>
                  )}
                </td>
                <td className="py-1">
                  {!k.revokedAt && !isExpired(k) && (
                    <span className="flex gap-2">
                      <Button onClick={() => rotate(k.id)} variant="outline" disabled={busy}>
                        Rotate
                      </Button>
                      <Button onClick={() => revoke(k.id)} variant="outline" disabled={busy}>
                        Revoke
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
