import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// A-FE-04: dark-mode text contrast. The five light-mode text colours below
// pass 4.5:1 on white but fail on the dark backgrounds (zinc-900 cards,
// zinc-950 page), so every use needs a `dark:text-<colour>-400` (or -300)
// variant. This test guards the sweep two ways: (1) it asserts the
// replacement colours really do pass WCAG 4.5:1 on every dark background the
// app uses, and (2) it scans the app's source for the five offending
// classes used without a matching dark variant. The finding's Playwright
// axe run in dark mode is a CI follow-up (e2e, not run locally).

// --- WCAG 2.x relative luminance / contrast ratio (same formula the audit used) ---
function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Tailwind palette hexes (v4).
const ORIGINALS: Record<string, string> = {
  "blue-600": "#2563eb",
  "zinc-500": "#71717a",
  "red-700": "#b91c1c",
  "emerald-700": "#047857",
  "amber-700": "#b45309",
};
const REPLACEMENTS: Record<string, string> = {
  "blue-400": "#60a5fa",
  "zinc-400": "#a1a1aa",
  "red-400": "#f87171",
  "emerald-400": "#34d399",
  "amber-400": "#fbbf24",
};
// Dark shades a `dark:text-…` variant may use, with their hexes. Only -300
// and -400 are listed: anything darker fails 4.5:1 on zinc-900, so the scan
// below rejects it.
const DARK_SHADES: Record<string, Record<string, string>> = {
  blue: { "300": "#93c5fd", "400": "#60a5fa" },
  zinc: { "300": "#d4d4d8", "400": "#a1a1aa" },
  red: { "300": "#fca5a5", "400": "#f87171" },
  emerald: { "300": "#6ee7b7", "400": "#34d399" },
  amber: { "300": "#fcd34d", "400": "#fbbf24" },
};
const DARK_BACKGROUNDS: Record<string, string> = {
  "zinc-900 (dark card)": "#18181b",
  "zinc-950 (dark page)": "#09090b",
  "zinc-800": "#27272a",
  "amber-950": "#451a03",
};
const LIGHT_TO_DARK: Record<string, string> = {
  "blue-600": "blue",
  "zinc-500": "zinc",
  "red-700": "red",
  "emerald-700": "emerald",
  "amber-700": "amber",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("A-FE-04 dark-mode text contrast", () => {
  it("replacement colours pass 4.5:1 on every dark background the app uses", () => {
    for (const [name, hex] of Object.entries(REPLACEMENTS)) {
      for (const [bgName, bg] of Object.entries(DARK_BACKGROUNDS)) {
        const ratio = contrastRatio(hex, bg);
        expect(
          ratio,
          `${name} (${hex}) on ${bgName} (${bg}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the original colours fail 4.5:1 on zinc-900 (why the sweep exists)", () => {
    for (const [name, hex] of Object.entries(ORIGINALS)) {
      expect(contrastRatio(hex, "#18181b")).toBeLessThan(4.5);
    }
  });

  it("no offending text colour is used without a passing dark variant", () => {
    // Files this fix could not touch (A-FE-03 file freeze). They still need
    // the same dark: sweep in a follow-up that owns those files. Each entry
    // must still have at least one unguarded use — the test fails if an
    // entry is fixed but left listed, so the allowlist cannot go stale.
    const ALLOWLIST: Record<string, string> = {
      "app/(app)/integrations/page.tsx": "A-FE-03 file freeze; 14 unguarded uses, needs the same sweep",
      "app/(app)/integrations/ConnectionActions.tsx": "A-FE-03 file freeze; 8 unguarded uses, needs the same sweep",
    };
    const srcDir = path.resolve(process.cwd(), "src");
    const tokenRe = /text-(blue-600|zinc-500|red-700|emerald-700|amber-700)\b/g;
    const violations: string[] = [];
    let guarded = 0;
    let total = 0;
    for (const file of walk(srcDir)) {
      const rel = path.relative(srcDir, file);
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      let m: RegExpExecArray | null;
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(text))) {
        total++;
        const token = m[1];
        const color = LIGHT_TO_DARK[token];
        const lineNo = text.slice(0, m.index).split("\n").length;
        // The class string is the enclosing double-quoted literal. Every
        // className in this codebase is double-quoted; a use outside one
        // is a violation so the test can be extended, not silently skipped.
        const open = text.lastIndexOf('"', m.index - 1);
        const close = text.indexOf('"', m.index + m[0].length);
        const span = open === -1 || close === -1 ? "" : text.slice(open + 1, close);
        const dark = new RegExp(`dark:text-${color}-(\\d+)`).exec(span);
        if (!dark) {
          if (rel in ALLOWLIST) continue;
          violations.push(
            `${rel}:${lineNo} text-${token} has no dark:text-${color}-* variant — ${lines[lineNo - 1].trim().slice(0, 120)}`,
          );
          continue;
        }
        const shadeHex = DARK_SHADES[color][dark[1]];
        if (!shadeHex) {
          violations.push(`${rel}:${lineNo} dark:text-${color}-${dark[1]} is not a known passing shade`);
          continue;
        }
        const ratio900 = contrastRatio(shadeHex, "#18181b");
        const ratio950 = contrastRatio(shadeHex, "#09090b");
        if (ratio900 < 4.5 || ratio950 < 4.5) {
          violations.push(
            `${rel}:${lineNo} dark:text-${color}-${dark[1]} is ${ratio900.toFixed(2)}:1 on zinc-900 / ${ratio950.toFixed(2)}:1 on zinc-950, below 4.5:1`,
          );
          continue;
        }
        guarded++;
      }
    }
    expect(total, "expected the scan to find the swept text colours").toBeGreaterThan(100);
    expect(guarded, "expected most uses to carry a passing dark variant").toBeGreaterThan(100);
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      const text = fs.readFileSync(path.join(srcDir, rel), "utf8");
      tokenRe.lastIndex = 0;
      let unguarded = 0;
      let m: RegExpExecArray | null;
      while ((m = tokenRe.exec(text))) {
        const color = LIGHT_TO_DARK[m[1]];
        const open = text.lastIndexOf('"', m.index - 1);
        const close = text.indexOf('"', m.index + m[0].length);
        const span = open === -1 || close === -1 ? "" : text.slice(open + 1, close);
        if (!new RegExp(`dark:text-${color}-\\d+`).test(span)) unguarded++;
      }
      expect(
        unguarded,
        `${rel} is allowlisted (${reason}) but has no unguarded use left — remove it from the allowlist`,
      ).toBeGreaterThan(0);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
