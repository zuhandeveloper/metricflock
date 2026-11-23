"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

type Props = {
  transferId: string;
  status: string;
  canDestination: boolean;
  canCancel: boolean;
};

export default function TransferActions({ transferId, status, canDestination, canCancel }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(action: string) {
    setBusy(action);
    setError("");
    const res = await fetch(`/api/transfers/${transferId}/${action}`, { method: "POST" });
    setBusy("");
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "action_failed");
      return;
    }
    router.refresh();
  }
  const open = ["INITIATED", "PENDING_ACCEPTANCE", "PENDING_CONNECTION"].includes(status);
  if (!open) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "PENDING_ACCEPTANCE" && canDestination && (
        <>
          <Button type="button" onClick={() => act("accept")}>
            {busy === "accept" ? "Accepting…" : "Accept"}
          </Button>
          <Button type="button" variant="outline" onClick={() => act("reject")}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </>
      )}
      {status === "PENDING_CONNECTION" && canDestination && (
        <Button type="button" onClick={() => act("complete")}>
          {busy === "complete" ? "Completing…" : "Complete transfer"}
        </Button>
      )}
      {canCancel && (
        <Button type="button" variant="outline" onClick={() => act("cancel")}>
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </div>
  );
}
