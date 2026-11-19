"use client";
import { useRouter, useSearchParams } from "next/navigation";
const RANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["28d", "Last 28 days"], ["90d", "Last 90 days"], ["12m", "Last 12 months"]] as const;
export default function DateRangePicker() {
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get("range") ?? "28d";
  return (
    <div className="flex flex-wrap gap-1">
      {RANGES.map(([value, label]) => (
        <button key={value} onClick={() => { const p = new URLSearchParams(params.toString()); p.set("range", value); router.push(`?${p.toString()}`); }}
          className={`rounded-full px-3 py-1 text-xs font-medium ${current === value ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700"}`}>{label}</button>
      ))}
    </div>
  );
}
