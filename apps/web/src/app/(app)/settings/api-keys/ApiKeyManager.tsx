"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Badge } from "@/components/ui";

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export function ApiKeyManager({ initial }: { initial: KeyRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newSecret, setNewSecret] = useState("");

  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    setNewSecret("");
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = (await res.json().catch(() => null)) as { secret?: string; error?: string } | null;
    setBusy(false);
    if (!res.ok) return setError(data?.error ?? `request_failed_${res.status}`);
    setNewSecret(data?.secret ?? "");
    setName("");
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
        <Button onClick={create} disabled={busy}>
          Create API key
        </Button>
      </div>
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
                <td className="py-1 pr-2">
                  {k.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}
                </td>
                <td className="py-1">
                  {!k.revokedAt && (
                    <Button onClick={() => revoke(k.id)} variant="outline" disabled={busy}>
                      Revoke
                    </Button>
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
