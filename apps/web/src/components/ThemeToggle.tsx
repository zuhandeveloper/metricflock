"use client";
export default function ThemeToggle() {
  return (
    <button
      onClick={() => document.documentElement.classList.toggle("dark")}
      className="rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
      aria-label="Toggle dark mode"
    >
      Dark / Light
    </button>
  );
}
