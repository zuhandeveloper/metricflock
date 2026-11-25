"use client";
import { useEffect, useState } from "react";

// A-FE-12: the theme choice is persisted in a `theme` cookie. The root
// layout reads it server-side and renders the `dark` class on <html>, so
// reloads/navigation keep the theme with no flash and no inline script
// (the nonce-based CSP would block one). On a first visit (no cookie)
// the OS preference is applied once and persisted.
const THEME_COOKIE = "theme";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function readThemeCookie(): "dark" | "light" | null {
  const match = document.cookie.match(/(?:^|;\s*)theme=(dark|light)\b/);
  return match ? (match[1] as "dark" | "light") : null;
}

function writeThemeCookie(value: "dark" | "light") {
  document.cookie = `${THEME_COOKIE}=${value}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = readThemeCookie();
    const isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", isDark);
    if (!stored) writeThemeCookie(isDark ? "dark" : "light");
    setDark(isDark);
  }, []);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    writeThemeCookie(next ? "dark" : "light");
    setDark(next);
  }

  return (
    <button
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Toggle dark mode"
      className="rounded-lg border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700"
    >
      Dark / Light
    </button>
  );
}
