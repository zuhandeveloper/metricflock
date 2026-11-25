"use client";
import { useEffect } from "react";
import { Button, Card } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app-error]", error);
  }, [error]);
  return (
    <Card className="p-8 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        This page failed to load. Your data is safe — try again, and if it keeps happening, quote reference{" "}
        {error.digest ?? "n/a"} when reporting it.
      </p>
      <div className="mt-4">
        <Button onClick={reset}>Try again</Button>
      </div>
    </Card>
  );
}
