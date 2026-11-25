import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// A-FE-06: wide tables had no horizontal-scroll container. Every
// `table.w-full` sat directly inside a `Card.p-4` (the Card has no
// `overflow-hidden`), so a 6-column table's minimum content width
// exceeded a 390 px viewport and forced page-level horizontal scrolling.
// The fix wraps every table in `div.overflow-x-auto` so the table
// scrolls inside its card, and adds `flex-wrap` to the websites filter
// form. This source scan guards both (same precedent as A-FE-04's
// dark-mode scan). The finding's Playwright 390 px viewport test
// (asserting `document.documentElement.scrollWidth <= innerWidth` on the
// table pages) is a CI follow-up (e2e, not run locally).

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Nearest non-blank line strictly before `index` (0-based), or -1.
function prevNonBlank(lines: string[], index: number): number {
  for (let i = index - 1; i >= 0; i--) if (lines[i].trim() !== "") return i;
  return -1;
}

// Nearest non-blank line strictly after `index` (0-based), or -1.
function nextNonBlank(lines: string[], index: number): number {
  for (let i = index + 1; i < lines.length; i++) if (lines[i].trim() !== "") return i;
  return -1;
}

describe("A-FE-06 table scroll wrappers", () => {
  it("every table is wrapped in an overflow-x-auto container", () => {
    const srcDir = path.resolve(process.cwd(), "src");
    const violations: string[] = [];
    let tables = 0;
    for (const file of walk(srcDir)) {
      const rel = path.relative(srcDir, file);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("<table")) continue;
        tables++;
        // The wrapper's open tag must be the nearest non-blank line above.
        const open = prevNonBlank(lines, i);
        if (open === -1 || !lines[open].includes("overflow-x-auto")) {
          violations.push(`${rel}:${i + 1} <table> is not directly preceded by an overflow-x-auto wrapper`);
          continue;
        }
        // The matching </table> must be followed by the wrapper's </div>.
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].includes("</table>")) {
            close = j;
            break;
          }
        }
        if (close === -1) {
          violations.push(`${rel}:${i + 1} <table> has no closing </table>`);
          continue;
        }
        const after = nextNonBlank(lines, close);
        if (after === -1 || lines[after].trim() !== "</div>") {
          violations.push(`${rel}:${close + 1} </table> is not followed by the wrapper's </div>`);
        }
      }
    }
    // Sanity floor: the scan must actually find the app's tables (11 at
    // the time of the fix), so an empty tree cannot pass silently.
    expect(tables, "expected the scan to find the app's tables").toBeGreaterThanOrEqual(11);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the websites filter form wraps (flex-wrap)", () => {
    const file = path.resolve(process.cwd(), "src/app/(app)/websites/page.tsx");
    const text = fs.readFileSync(file, "utf8");
    const forms = [...text.matchAll(/<form\s+className="([^"]*)"/g)];
    expect(forms.length, "expected the websites filter form").toBeGreaterThanOrEqual(1);
    for (const [, cls] of forms) {
      expect(cls, `websites filter form className "${cls}" lacks flex-wrap`).toContain("flex-wrap");
    }
  });
});
