"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function RequeueButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act() {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/sync/requeue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? `request_failed_${res.status}`);
      return;
    }
    router.refresh();
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={() => void act()}>
        {busy ? "Requeueing…" : "Requeue"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
