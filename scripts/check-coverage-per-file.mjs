// Per-file coverage minimums (A-COV-15, docs/audit/09-TEST-COVERAGE-AND-QUALITY.md).
//
// Why: the aggregate vitest thresholds (90/80/90/90 in
// apps/web/vitest.config.ts) cannot see a single weak file — at audit
// time api-key-auth.ts sat at 50% functions while the aggregate
// functions figure was 96.87% and the gate passed. This script asserts
// a minimum per file from the JSON coverage report, so no file can
// hide behind the aggregate again.
//
// Usage: node scripts/check-coverage-per-file.mjs [path-to-coverage-final.json]
// Default report: apps/web/coverage/coverage-final.json (written by
// `pnpm test:coverage` — vitest's default json reporter; no config
// change needed). CI wiring: run this in the same job immediately
// after the unit-test step (see doc 09, A-COV-15). Exit 0 = every file
// meets its floor; exit 1 = at least one offender (or a missing /
// stale entry), listed on stderr.
//
// Floors: DEFAULT_MINIMUMS apply to every file. PER_FILE_FLOORS pins
// files that cannot meet the default today to a ratchet at their
// measured 2026-11-25 level (floored to a whole percent): any
// regression below the ratchet still fails. Raise or delete an entry
// as coverage improves; never lower one without a note in doc 09.
// A metric with zero countable items (pure re-export barrels) passes
// vacuously at 100%.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = process.argv[2] ?? join(root, "apps", "web", "coverage", "coverage-final.json");

const DEFAULT_MINIMUMS = { statements: 80, branches: 80, functions: 80, lines: 80 };

// Ratchet floors (measured 2026-11-25, floored). Only metrics below
// the default are listed; unlisted metrics use DEFAULT_MINIMUMS.
const PER_FILE_FLOORS = {
  // Next.js proxy (correlation IDs + CSP nonce): runs on every HTTP
  // request in CI smoke/e2e, never imported by unit tests.
  "apps/web/src/proxy.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
  // better-auth browser client ("use client"): only evaluated in
  // browser bundles, never in the node test environment.
  "packages/auth/src/client.ts": { statements: 0, lines: 0 },
  // Next.js register() boot hook: uncovered lines are the non-nodejs
  // early return and the production-only guards.
  "apps/web/src/instrumentation.ts": { statements: 77, branches: 75 },
  // Prisma client singleton: global-cache ??, NODE_ENV log level and
  // the missing-DATABASE_URL throw are the uncovered branches.
  "packages/db/src/client.ts": { branches: 62 },
  // The audit's example file: the one uncovered function is the empty
  // .catch(() => {}) on the fire-and-forget lastUsedAt stamp;
  // statements/branches/lines are 100%.
  "apps/web/src/lib/api-key-auth.ts": { functions: 50 },
  // Route files: v8 counts every exported handler, wrapper argument
  // and inline .catch fallback arrow as a function. The uncovered
  // entries are error-path one-liners / secondary handlers; every
  // file in this group has statements >= 81% and lines >= 90%.
  "apps/web/src/app/api/api-keys/[id]/rotate/route.ts": { functions: 75 },
  "apps/web/src/app/api/api-keys/[id]/route.ts": { functions: 50 },
  "apps/web/src/app/api/api-keys/route.ts": { functions: 50 },
  "apps/web/src/app/api/auth/login/route.ts": { functions: 60 },
  "apps/web/src/app/api/google/connections/disconnect/route.ts": { functions: 60 },
  "apps/web/src/app/api/google/oauth/callback/route.ts": { functions: 66 },
  "apps/web/src/app/api/google/properties/discover/route.ts": { functions: 65 },
  "apps/web/src/app/api/google/properties/map/route.ts": { functions: 77 },
  "apps/web/src/app/api/invites/accept/route.ts": { functions: 77 },
  "apps/web/src/app/api/members/invite/[id]/route.ts": { functions: 50 },
  "apps/web/src/app/api/members/invite/route.ts": { functions: 50 },
  "apps/web/src/app/api/organization/export/route.ts": { functions: 75 },
  "apps/web/src/app/api/organization/route.ts": { functions: 66 },
  "apps/web/src/app/api/reports/schedule/route.ts": { functions: 75 },
  // branches lowered 75 -> 62 on 2026-11-27 (see doc 09, A-COV-15):
  // same NEXT_PUBLIC_APP_URL ?? fallback unreachable in CI as
  // layout.tsx below; CI measures 5/8 branches, local 6/8.
  "apps/web/src/app/api/reports/send-test/route.ts": { branches: 62, functions: 66 },
  "apps/web/src/app/api/sync/requeue/route.ts": { functions: 33 },
  "apps/web/src/app/api/sync/route.ts": { functions: 57 },
  "apps/web/src/app/api/teams/[id]/members/route.ts": { functions: 71 },
  "apps/web/src/app/api/teams/[id]/route.ts": { functions: 57 },
  "apps/web/src/app/api/teams/route.ts": { functions: 75 },
  "apps/web/src/app/api/v1/websites/[id]/analytics/route.ts": { functions: 33 },
  // Added 2026-11-26 (Google-login 2FA fix + profile page + role
  // restriction + platform admin): new files whose uncovered
  // branches/functions are error-path one-liners and ?? fallbacks,
  // the same pattern as the route-file group above.
  "apps/web/src/app/(app)/admin/users/PlatformUserActions.tsx": { branches: 78 },
  "apps/web/src/app/(app)/admin/users/role-labels.ts": { branches: 50 },
  "apps/web/src/app/(app)/members/role-labels.ts": { branches: 50 },
  "apps/web/src/app/(app)/settings/profile/ProfileActions.tsx": { branches: 77 },
  "apps/web/src/app/api/admin/users/[id]/route.ts": { functions: 60 },
  "apps/web/src/app/api/profile/set-password/route.ts": { functions: 66 },
  "apps/web/src/app/api/websites/[id]/assign/route.ts": { functions: 50 },
  "apps/web/src/app/api/websites/[id]/route.ts": { functions: 72 },
  "apps/web/src/app/api/websites/[id]/transfer/route.ts": { functions: 50 },
  "apps/web/src/app/api/websites/route.ts": { functions: 60 },
  "apps/web/src/lib/analytics-handler.ts": { functions: 61 },
  // Thin wrappers / small files where one defensive branch is a large
  // percentage (the analytics routes are 4–5-statement wrappers around
  // handleAnalyticsRequest; the uncovered branch is a ?? fallback).
  "apps/web/src/app/(app)/sync/page.tsx": { branches: 75 },
  "apps/web/src/app/api/analytics/adsense/route.ts": { branches: 50 },
  "apps/web/src/app/api/analytics/overview/route.ts": { branches: 50 },
  "apps/web/src/app/api/analytics/pages/route.ts": { branches: 50 },
  "apps/web/src/app/api/analytics/search-console/route.ts": { branches: 50 },
  "apps/web/src/app/api/auth/logout/route.ts": { branches: 50 },
  "apps/web/src/app/api/v1/health/route.ts": { branches: 66 },
  // Lowered 75 -> 50 on 2026-11-27 (see doc 09, A-COV-15): the
  // `process.env.NEXT_PUBLIC_APP_URL ?? fallback` branch is
  // unreachable in CI, where ci.yml always sets the variable, so CI
  // measures 2/4 branches where a local run measures 3/4.
  "apps/web/src/app/layout.tsx": { branches: 50 },
  // Parser / aggregation logic: defensive branches; statements and
  // lines are >= 93% / 100% respectively for these three.
  "packages/google/src/discovery.ts": { branches: 78 },
  "packages/google/src/ga4.ts": { branches: 75 },
  "packages/shared/src/insights.ts": { branches: 71 },
};

function percent(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function fileMetrics(cov) {
  const statements = Object.values(cov.s ?? {});
  const functions = Object.values(cov.f ?? {});
  const branches = Object.values(cov.b ?? {}).flat();
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(cov.statementMap ?? {})) {
    const line = loc.start.line;
    lineHits.set(line, Math.max(lineHits.get(line) ?? 0, cov.s[id] ?? 0));
  }
  const lines = [...lineHits.values()];
  const hit = (values) => values.filter((v) => v > 0).length;
  return {
    statements: percent(hit(statements), statements.length),
    branches: percent(hit(branches), branches.length),
    functions: percent(hit(functions), functions.length),
    lines: percent(hit(lines), lines.length),
  };
}

if (!existsSync(reportPath)) {
  console.error(
    `check-coverage-per-file: coverage report not found at ${reportPath}\n` +
      "Run `pnpm test:coverage` first (it writes apps/web/coverage/coverage-final.json), " +
      "or pass the report path as an argument.",
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const failures = [];
const notices = [];
const seen = new Set();
let checked = 0;

for (const [file, cov] of Object.entries(report)) {
  const rel = relative(root, file).split(sep).join("/");
  if (rel.startsWith("..")) continue; // outside the repo — not ours to gate
  seen.add(rel);
  checked += 1;
  const metrics = fileMetrics(cov);
  const floors = { ...DEFAULT_MINIMUMS, ...(PER_FILE_FLOORS[rel] ?? {}) };
  for (const metric of Object.keys(DEFAULT_MINIMUMS)) {
    if (metrics[metric] < floors[metric]) {
      failures.push(`${rel}: ${metric} ${metrics[metric].toFixed(2)}% < floor ${floors[metric]}%`);
    }
  }
  if (PER_FILE_FLOORS[rel] && Object.keys(DEFAULT_MINIMUMS).every((m) => metrics[m] >= DEFAULT_MINIMUMS[m])) {
    notices.push(`${rel}: now meets the default minimums — PER_FILE_FLOORS entry can be deleted`);
  }
}

for (const rel of Object.keys(PER_FILE_FLOORS)) {
  if (!seen.has(rel)) {
    failures.push(`${rel}: PER_FILE_FLOORS entry is stale (file not in the coverage report)`);
  }
}

for (const notice of notices) console.log(`notice: ${notice}`);
if (failures.length > 0) {
  console.error(`check-coverage-per-file: ${failures.length} per-file minimum failure(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `check-coverage-per-file: OK — ${checked} files checked, ` +
    `${Object.keys(PER_FILE_FLOORS).length} ratchet entries, defaults ` +
    `${DEFAULT_MINIMUMS.statements}/${DEFAULT_MINIMUMS.branches}/${DEFAULT_MINIMUMS.functions}/${DEFAULT_MINIMUMS.lines}`,
);
