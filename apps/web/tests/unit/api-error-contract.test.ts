/**
 * A-API-11 — API error-envelope contract test (static, over source).
 *
 * The central error contract (A-API-02/03/04, `lib/api-error.ts`) is
 * `{ error: <stable_code>, requestId }` with `details` only for
 * validation issues the client can act on. `withApiErrors` injects the
 * `requestId` into any bare `{ error }` body, so a plain
 * `NextResponse.json({ error })` site is already conformant on the wire —
 * but any EXTRA top-level field (`message`, `status`, `transferId`,
 * `websites`, `type`, …) is NOT normalized: it leaks a second shape past
 * the wrapper. This test therefore asserts, over every route file and
 * the two lib helpers that build error responses:
 *   1. every error-response object literal has top-level keys ⊆
 *      { error, details, requestId } (no extra fields, no spreads);
 *   2. every route handler is wrapped by `withApiErrors` (directly, or
 *      via `handleAnalyticsRequest`, which wraps internally) so the
 *      requestId injection actually applies.
 * Success bodies are deliberately NOT unified here: `{ status: "ok" }`,
 * `{ ok: true }`, `{ deleted: true }`, bare `{ team }` / `{ website }` /
 * `{ key, secret }`, the analytics envelope and the list shapes are the
 * documented contract (see doc 02, A-API-11) — unifying them would be a
 * breaking change for the UI and v1 clients.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const ROUTE_GLOB = join(SRC, "app", "api");
const LIB_FILES = ["api-key-auth.ts", "transfers.ts"].map((f) => join(SRC, "lib", f));
// NOTE: lib/api-error.ts itself is NOT scanned — it IS the enforcer:
// its constructed bodies are `{ error, requestId }` only, and its
// `enrichErrorResponse` spread re-emits a body already checked to carry
// a string `error`, adding only `requestId`.
const ALLOWED_ERROR_KEYS = new Set(["error", "details", "requestId"]);

function listRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listRouteFiles(p, out);
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

/** Strip // and block comments, string-aware (URLs in strings survive). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  let esc = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Extract the object literals passed as the first arg of every
 *  `NextResponse.json(` call (balanced-brace, string-aware). */
function extractJsonObjects(src: string): string[] {
  const out: string[] = [];
  const needle = "NextResponse.json(";
  let i = 0;
  while (true) {
    const idx = src.indexOf(needle, i);
    if (idx === -1) break;
    let j = idx + needle.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== "{") {
      i = j;
      continue;
    }
    let depth = 0;
    let inStr: string | null = null;
    let esc = false;
    let k = j;
    for (; k < src.length; k++) {
      const ch = src[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
    }
    out.push(src.slice(j, k));
    i = k;
  }
  return out;
}

/** Top-level keys of an object literal (depth-0 commas, string-aware).
 *  Returns `{ keys, hasSpread }`. */
function topLevelKeys(obj: string): { keys: string[]; hasSpread: boolean } {
  const inner = obj.slice(1, -1);
  const segments: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  let start = 0;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      segments.push(inner.slice(start, k));
      start = k + 1;
    }
  }
  segments.push(inner.slice(start));
  const keys: string[] = [];
  let hasSpread = false;
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("...")) {
      hasSpread = true;
      continue;
    }
    const m = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/);
    if (m) keys.push(m[1] ?? m[2] ?? m[3]);
    else {
      // Shorthand property (`{ error, status }`) — the identifier IS the key.
      const shorthand = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
      if (shorthand) keys.push(shorthand[1]);
    }
  }
  return { keys, hasSpread };
}

describe("API error-envelope contract (A-API-11)", () => {
  const routeFiles = listRouteFiles(ROUTE_GLOB);
  const scannedFiles = [...routeFiles, ...LIB_FILES];

  it("scans a non-empty set of route files", () => {
    expect(routeFiles.length).toBeGreaterThan(30);
  });

  it("every error-response object has only { error, details, requestId } top-level keys", () => {
    const violations: string[] = [];
    for (const file of scannedFiles) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const obj of extractJsonObjects(src)) {
        const { keys, hasSpread } = topLevelKeys(obj);
        if (!keys.includes("error")) continue; // success body — not an error envelope
        const extra = keys.filter((k) => !ALLOWED_ERROR_KEYS.has(k));
        if (extra.length > 0 || hasSpread) {
          violations.push(
            `${file.split("apps/web/src/")[1]}: { ${keys.join(", ")} }` +
              (hasSpread ? " (spread — keys not statically checkable)" : "") +
              ` — extra top-level field(s): ${extra.join(", ") || "spread"}. Move them into details via apiError().`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every route handler is wrapped by withApiErrors (or handleAnalyticsRequest)", () => {
    const unwrapped: string[] = [];
    for (const file of routeFiles) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("withApiErrors(") && !src.includes("handleAnalyticsRequest(")) {
        unwrapped.push(file.split("apps/web/src/")[1]);
      }
    }
    expect(unwrapped).toEqual([]);
  });
});
