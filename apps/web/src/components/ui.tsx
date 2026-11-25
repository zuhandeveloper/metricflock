import type { ReactNode } from "react";
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      {children}
    </div>
  );
}
export function Badge({
  children,
  tone = "zinc",
}: {
  children: ReactNode;
  tone?: "zinc" | "green" | "red" | "amber" | "blue";
}) {
  const tones: Record<string, string> = {
    zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "outline";
  className?: string;
  disabled?: boolean;
}) {
  const v =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
      : variant === "outline"
        ? "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        : "hover:bg-zinc-100 dark:hover:bg-zinc-800";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${v} ${className}`}
    >
      {children}
    </button>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900 ${props.className ?? ""}`}
    />
  );
}
export function Skeleton({ className = "h-24" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800 ${className}`} />;
}
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}
export function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </Card>
  );
}
export function ConnectionStatus({ status }: { status: string }) {
  const tone = status === "ACTIVE" ? "green" : status === "NEEDS_REAUTH" || status === "EXPIRED" ? "amber" : "red";
  return <Badge tone={tone}>{status}</Badge>;
}
