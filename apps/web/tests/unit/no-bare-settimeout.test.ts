import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A-COV-12 guard: the unit suite must not grow new bare `setTimeout` /
// `setInterval` sleeps. Real-timer waits are the classic flake source on
// loaded CI runners (a sleep is a minimum, not exact); where a test needs
// time to pass it should use fake timers (`vi.useFakeTimers` +
// `vi.setSystemTime` / `vi.advanceTimersByTimeAsync`), as the rate-limit
// window-expiry and ad-manager retry tests now do.
//
// The allowlist below is a ratchet, not a blanket exemption: every entry
// records the exact number of bare timers in that file and why fake timers
// cannot replace them. Adding a bare timer anywhere — including to an
// allowlisted file — fails this test until the entry is updated consciously
// with a justification. Removing one also fails, so stale entries cannot
// linger. Prefer fake timers; allowlist only when the wait is for real
// async I/O or simulates network latency for a busy-state assertion.
const UNIT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = "no-bare-settimeout.test.ts";

const MOCK_LATENCY =
  "mock fetch latency (200 ms) so the test can assert the component's busy/disabled state while the request is in flight";
const REAL_LIFECYCLE =
  "polls/waits for real async worker/server lifecycle (startup, shutdown, listen) that fake timers cannot drive";

const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "components/AuthForms.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/LoginForm.test.tsx": { count: 2, reason: MOCK_LATENCY },
  "components/MemberForms.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/ReportScheduleForm.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/SecurityActions.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/TeamForms.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/TransferActions.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/WebsiteActions.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/WebsiteForms.test.tsx": { count: 1, reason: MOCK_LATENCY },
  "components/helpers.ts": {
    count: 1,
    reason:
      "mockFetchDelayed shared helper: simulated network latency so tests can double-click while the component is busy",
  },
  "discovery-pagination.test.ts": {
    count: 1,
    reason:
      "mock simulates a slow upstream listing against the production wall-clock deadline (A-API-13); the deadline mechanism is the subject under test",
  },
  "worker-health-listen-error.test.ts": { count: 1, reason: REAL_LIFECYCLE },
  "worker-index-default-port.test.ts": { count: 1, reason: REAL_LIFECYCLE },
  "worker-index-no-bull.test.ts": { count: 1, reason: REAL_LIFECYCLE },
  "worker-index.test.ts": { count: 4, reason: REAL_LIFECYCLE },
  "worker-scheduler-stop.test.ts": { count: 2, reason: REAL_LIFECYCLE },
  "worker-scheduler.test.ts": {
    count: 4,
    reason: "fake-timer-driven mock latency (advanced via vi.advanceTimersByTimeAsync); no real time passes",
  },
  "worker-shutdown.test.ts": { count: 4, reason: REAL_LIFECYCLE },
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function countBareTimers(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    // Skip comment lines so prose mentioning setTimeout is not flagged.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    count += (line.match(/\bsetTimeout\(/g) ?? []).length;
    count += (line.match(/\bsetInterval\(/g) ?? []).length;
  }
  return count;
}

describe("suite hygiene: no bare setTimeout in tests (A-COV-12)", () => {
  it("every bare timer in the unit suite is allowlisted with a justification", () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    for (const file of listSourceFiles(UNIT_DIR)) {
      const rel = path.relative(UNIT_DIR, file);
      if (rel === SELF) continue;
      seen.add(rel);
      const count = countBareTimers(readFileSync(file, "utf8"));
      const allowed = ALLOWLIST[rel];
      if (!allowed && count > 0) {
        violations.push(
          `${rel}: ${count} bare timer(s), not allowlisted — use fake timers (vi.useFakeTimers) or add a justified allowlist entry`,
        );
      } else if (allowed && count !== allowed.count) {
        violations.push(
          `${rel}: ${count} bare timer(s), allowlist records ${allowed.count} — update the allowlist consciously`,
        );
      }
    }
    for (const rel of Object.keys(ALLOWLIST)) {
      if (!seen.has(rel)) violations.push(`${rel}: allowlisted but file not found — remove the stale entry`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
