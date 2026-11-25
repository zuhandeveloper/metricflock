"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/invites/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `request_failed_${res.status}`);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <Button type="button" disabled={busy} onClick={() => void act()}>
        {busy ? "Joining…" : "Accept invite"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
