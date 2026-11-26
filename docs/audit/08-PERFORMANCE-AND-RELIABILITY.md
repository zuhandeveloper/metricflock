# 08 — Performance and Reliability Audit

Audit date: 2026-11-23. Auditor: independent audit (coordinator pass).
Repo: main HEAD `6e6d2b21`.

## 0.1 How this phase was verified

- Production build run locally (`next build`, exit 0, 2026-11-23) with
  route table and chunk sizes measured from `.next/`.
- Static review of query bounds, cache TTLs, scheduler intervals,
  rate limits, and backoff (code, not load).
- **Limits (honest):** no load tests were run — there is no staging
  environment in the sandbox, and production must not be load-tested.
  No latency percentiles (p50/p95/p99), no Core Web Vitals, and no
  DB query plans were measured: no Postgres in the sandbox, and
  `EXPLAIN` needs a live DB. The 100/1k/10k scale benchmark
  (`packages/db/scripts/benchmark-scale.ts`) has never been executed
  against a real database (see A-PERF-02). Anything below marked
  NOT RUN is not a pass.

## 0.2 Measured (local build, 2026-11-23)

| Metric                                          | Value                                                                                             | Evidence                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `next build`                                    | exit 0                                                                                            | `/tmp/audit-nextbuild.log`                              |
| Routes                                          | 75, **all dynamic (ƒ)** — zero static/prerendered pages                                           | build route table                                       |
| Client JS (`.next/static`)                      | 1.3 MB total (uncompressed)                                                                       | `du -sh .next/static`                                   |
| Largest single chunk                            | 448 KB (`2gl0j0y_fwmqn.js`, uncompressed; gzip ≈ 1/3)                                             | `du` on `.next/static/chunks`                           |
| Second chunk                                    | 228 KB                                                                                            | same                                                    |
| Unit suite wall time (sandbox, 1.5 shared CPUs) | 159–190s for 196 tests (import-bound: ~90% import time)                                           | local runs 2026-11-23; CI unit step ≈ 9s                |
| Dashboard list bound                            | `PAGE_SIZE = 50`, `take: 50`, connections capped                                                  | `apps/web/src/app/(app)/dashboard/page.tsx:16,47-48,58` |
| Cache TTLs                                      | overview/traffic snapshot 2700s, SC 28800s, AdSense/Ad Manager 10800s, realtime max(TTL, 300s)    | `packages/jobs/src/scheduler.ts` (`snapshotTtlSeconds`) |
| Scheduler intervals                             | realtime 300s, historical 45m, SC 8h, AdSense 3h, health 1h                                       | scheduler plan (Phase 5)                                |
| Sync backoff                                    | jittered exponential, 60s base doubling, 1h cap, ×0.5–1.0 jitter; custom backoff on all workers   | `packages/jobs/src/queue.ts`                            |
| Rate-limit failure mode                         | fail-closed for sensitive callers when Redis is down (verified by passing unit test in isolation) | `rate-limit-failclosed.test.ts` 2/2                     |
| `optimizePackageImports`                        | `lucide-react`, `recharts`                                                                        | `apps/web/next.config.ts`                               |

## 0.3 Findings

### A-PERF-01 (P2) — No load, latency, or Core Web Vitals evidence exists · FIXED 2026-11-24

- **Evidence:** no load-test script, no k6/Artillery config, no
  Lighthouse CI, no Web Vitals instrumentation, no APM in the repo.
  The brief's 10/50/100-concurrent-user measurements have never been
  taken anywhere (not in CI, not in docs).
- **Impact:** "production-ready" cannot be asserted for performance;
  the first traffic spike is the first load test. The dashboard is
  server-rendered per request (all routes dynamic), so every page view
  costs DB queries + (on snapshot miss) live Google calls.
- **Correction:** run a controlled load test against a staging deploy
  (10/50/100 concurrent users, record p50/p95/p99 + error rate), and
  add Lighthouse CI or Vercel Speed Insights for Core Web Vitals.
- **Status:** FIXED 2026-11-24 (tooling + procedure; the run itself is pending the owner's explicit staging approval — no traffic has been sent to any deployment).
- **Verification note:** revalidation confirmed the absence — the only load-test-like artefact is `apps/worker/scripts/load-test-scheduler.ts`, which measures in-memory scheduler planning capacity at 100/500 sites, not HTTP latency; no k6/Artillery config, Lighthouse CI, Speed Insights, or APM exists anywhere (repo-wide grep). Delivered `apps/web/scripts/load-test.mjs` (dependency-free Node, global fetch): ramps 10 → 50 → 100 concurrent users, `--seconds` per stage (default 30), per-endpoint p50/p95/p99 + error rate, human table + `--json`/`--out`. Guards mirror the benchmark scripts: refuses without `LOAD_TEST_CONFIRM=1`, refuses the four production hosts (`metricflock.bond`, `metricflock.vercel.app`, `metricflock-zuhan4.vercel.app`, `metricflock-git-main-zuhan4.vercel.app` — from the live project object), https-only for remote targets. `--dry-run` prints the plan and sends no traffic. Authenticated paths (`/dashboard`, `/api/websites`, `/api/analytics/overview`) run only when `LOAD_TEST_COOKIE` (+ `LOAD_TEST_WEBSITE_ID`) is set from the environment — never logged or committed. Proof: dry run on a staging preview URL prints the plan, exit 0; prod host / missing confirmation / http-remote each refuse with exit 1. +16 tests in `apps/web/tests/unit/load-test-script.test.ts` (percentiles, guards, plan). Run procedure: deploy staging first, then `LOAD_TEST_CONFIRM=1 node apps/web/scripts/load-test.mjs --url <staging-url>` (add `LOAD_TEST_COOKIE` + `LOAD_TEST_WEBSITE_ID` for the authenticated paths); record p50/p95/p99 + error rate per endpoint. Proposed bar (owner to confirm, not a committed SLO): overall error rate ≤ 1% and p95 < 2000 ms per endpoint. Speed Insights is NOT enabled: no `@vercel/speed-insights` package and no `<SpeedInsights/>` in the layout (grep); Vercel's own quickstart requires the package + component in `app/layout.tsx` for App Router, so it is a code change, not a dashboard-only toggle — adding it needs a package.json change (frozen for this fix) + layout edit, i.e. an owner decision. The Vercel MCP `get_project` summary exposes no Speed Insights field, so dashboard state could not be read via the connector; with no code integration, no Speed Insights data is collected either way. Lighthouse CI likewise needs a workflow change via the GitHub web UI.

### A-PERF-02 (P2) — Scale benchmark (100/1k/10k sites) never executed against a real DB · FIXED 2026-11-24

- **File:** `packages/db/scripts/benchmark-scale.ts`, `docs/audit/BENCHMARKS.md`.
- **Evidence:** the script exists and refuses to run without
  `BENCH_CONFIRM=1`; BENCHMARKS.md records only a JS simulation
  (O(W×I) vs single-pass Set: 10k sites 3,019.5ms → 8.75ms) and states
  DB timings were NOT run. The repo's "345×" figure is a simulation
  of the counting loop, not a measured DB query.
- **Impact:** the 10k-site claim is unproven; scheduler fan-out,
  queue lag, and DB load at scale are unknown.
- **Correction:** run `benchmark-scale.ts` against a staging Postgres
  at 100/1k/10k and record real timings before claiming scale.
- **Status:** CONFIRMED.
- **Verification (2026-11-24):** revalidation + procedure only — the run
  itself is still pending the owner's explicit staging-DB approval.
  The scheduler has not changed since A-WRK-12 (no later fix touched
  `apps/worker/src/scheduler.ts`; constants RETENTION_DAYS=30,
  WEBSITE_PAGE_SIZE=500, PRUNE_BATCH_SIZE=1000, STALE_RUNNING_MS=6h),
  and the script was still aligned on all four compared shapes: page
  scan (`status: { in: ["ACTIVE", "PENDING_SETUP"] }` + MAPPED filter,
  `take: 500`), per-page scoped last-success groupBy
  (`by: ["websiteId", "type"]`, 500 ids, 30-day window), stale RUNNING
  → FAILED (6h, `lastError: "stale_running"`), retention prune
  (30-day, SUCCEEDED/FAILED/PENDING/RETRYING, 1000 ids/batch). Two
  realignments made in `benchmark-scale.ts`: (1) the prune id-select
  now carries `orderBy: { id: "asc" }` like production's
  `pruneInBatches`; (2) the dashboard's FE-4 per-page last-sync
  groupBy (`by: ["websiteId"]`, first 50 page ids — dashboard
  PAGE_SIZE=50) is now measured alongside the scheduler's variant.
  The dashboard page query set was also re-checked against
  `dashboard/page.tsx` — count, 50-row page, connected count and
  provider groupBy all still match. Safety rails re-verified live
  (exit 1, no connection attempted): scale script refuses without
  `BENCH_CONFIRM=1` and refuses a `prisma.io` DATABASE_URL;
  throughput script refuses without `BENCH_CONFIRM=1`, without
  `REDIS_URL`, and against the production Redis host. Run procedure
  (see BENCHMARKS.md): staging Postgres + staging Redis, then
  `BENCH_CONFIRM=1 pnpm --filter @metricflock/db exec tsx
scripts/benchmark-scale.ts` (subset `BENCH_SIZES=100,1000`) and the
  throughput companion; record per-query timings at 100/1k/10k in
  BENCHMARKS.md "Results". Residual gaps (documented, not measured):
  the production analytics-cache prune and OAuth-state prune are not
  seeded/measured, and the org-level counts (team/user/connection)
  are not measured — none scales with website count.
  **The "345×" figure must still not be cited as scale evidence.**

### A-PERF-03 (P3) — All 75 routes are dynamic; no caching headers for pages · ADDRESSED 2026-11-25 (documentation; no code change)

- **Evidence:** build route table — every route is ƒ (dynamic). No
  `Cache-Control` for pages; only security headers are set in
  `next.config.ts`. Authenticated pages must be dynamic, but the
  public `/login` and error pages could be static.
- **Impact:** minor — every request pays full server render; Vercel
  cannot cache page HTML. Not a defect for an authenticated dashboard.
- **Correction:** none required; optionally mark `/login`,
  `/forgot-password`, and error pages static if they carry no
  per-request data.
- **Status:** CONFIRMED (observation, low impact).
- **Verification (2026-11-25):** revalidated with a fresh build (all 75
  routes ƒ) and a runtime experiment. No page can be made static today
  without a behavior change: the root layout reads `headers()` to stamp
  the per-request CSP nonce (F-6.8) and `cookies()` for the no-flash
  theme (A-FE-12), which opts every page into dynamic rendering. A
  `force-static` experiment on `/forgot-password` prerendered ○ but
  served 17 script tags with 0 nonces against the per-request nonce CSP
  (`strict-dynamic` blocks them — the page never hydrates), so it was
  reverted. `/login` and `/` read the session per request (signed-in
  redirect); `/invite/[token]` does a DB + session lookup;
  `/reset-password/[token]` renders the URL token. Next already sends
  `Cache-Control: private, no-cache, no-store, max-age=0,
must-revalidate` on dynamic pages, so no header change was needed.
  Unlocking static pages is an owner decision: give up nonce-CSP (or
  per-page CSP) for public pages, move `/login`'s redirect client-side,
  and/or move the theme read out of the root layout.

### A-PERF-04 (P3) — Unit suite is import-bound and slow off CI (159–190s) · ADDRESSED 2026-11-25 (isolate:false evaluated and rejected; hookTimeout already raised by A-BASE-01)

- **Evidence:** local runs: 196 tests in 159.71s / 189.79s, ~90%
  import time, 99 modules evaluated 217–246 times. Vitest itself
  suggests `isolate: false` (~38s faster). CI runs the same suite in
  ~9s on faster hardware.
- **Impact:** slow local feedback loop; combined with the 10s default
  hook timeout it caused a real local failure (A-BASE-01).
- **Correction:** evaluate `isolate: false` for the unit suite (watch
  for cross-test pollution — the rate-limit and cache modules hold
  module-level state) and raise `hookTimeout`.
- **Status:** CONFIRMED.
- **Verification (2026-11-25):** re-measured on the current suite
  (141 files, 1,531 tests): `pnpm run test:coverage` takes 170.8s wall
  in the sandbox. `isolate: false` was evaluated — it cuts the run to
  48.5s (3.5×) but 221 tests in 32 files fail: with a shared module
  registry, per-file `vi.mock` registrations bleed across files (a
  null-session auth mock from one file makes later route tests return
  401; the same bleed hits googleapis/bullmq/ioredis mocks and the
  module-level state in `packages/shared` — rate-limit `buckets`,
  metrics `counters`, the cache Redis singleton, the cached env).
  Making every file's mocks registry-safe is a suite-wide rewrite, not
  a minimal fix, so isolation stays ON and the evaluation is recorded
  in a comment in `apps/web/vitest.config.ts`. The `hookTimeout` half
  was already done by A-BASE-01 (`hookTimeout: 30_000`, 2026-11-24);
  the slowest observable hook (the `rate-limit-failclosed` beforeAll
  barrel re-import) costs ~1s cold here, so 30s keeps ~3× headroom over
  the >10s constrained-CPU flake that motivated it. `testTimeout` stays
  at the 5s default — the full suite passes with it. Unlocking the
  speedup is a future owner decision: make mocks registry-safe file by
  file, or split the suite into isolated/non-isolated projects.

### A-PERF-05 (P3) — No DB query-plan evidence for the hot paths · FIXED 2026-11-26

- **Evidence:** dashboard aggregation, portfolio loader, and scheduler
  input queries have no recorded `EXPLAIN ANALYZE` output; indexes
  were reviewed statically in Phase 3 only.
- **Impact:** a missing index on a hot path would only show up under
  real data volume.
- **Correction:** capture `EXPLAIN ANALYZE` for the dashboard query
  set and scheduler inputs at 1k/10k scale (with A-PERF-02).
- **Status:** CONFIRMED (absence).
- **Verification (2026-11-26):** owner-approved run in a temporary
  schema on the production server (the PrismaPg adapter ignores the
  `schema` URL parameter, so `benchmark-scale.ts` itself could not
  be isolated; running it on the public schema was rejected because
  its ACTIVE + MAPPED seed rows would be picked up by the live
  scheduler). Same seed shape at 100 / 1k / 10k websites;
  `EXPLAIN (ANALYZE, BUFFERS)` on SQL equivalents of the script's
  query set. At 10k websites every hot query executes in ≤ 5.7 ms;
  page-scoped queries are flat, org-scoped counts/pages grow with
  org size but stay single-digit ms — no missing-index cliff.
  Full table + method caveats in `BENCHMARKS.md` ("Results").
  Schema dropped afterwards; production counts verified unchanged.

## 0.4 Verdict table

| Category                        | Verdict                                                |
| ------------------------------- | ------------------------------------------------------ |
| Production build                | PASS (exit 0; 75 routes)                               |
| Client bundle size              | PASS (1.3 MB total uncompressed; largest chunk 448 KB) |
| Dashboard query bounds          | PASS (paginated, capped — static review)               |
| Cache/snapshot TTLs             | PASS (static review)                                   |
| Backoff / retry design          | PASS (static review)                                   |
| Load testing (10/50/100 users)  | **NOT RUN — A-PERF-01**                                |
| Latency percentiles             | **NOT RUN**                                            |
| Core Web Vitals                 | **NOT RUN**                                            |
| Scale benchmark (real DB)       | **NOT RUN — A-PERF-02**                                |
| DB query plans                  | **NOT RUN — A-PERF-05**                                |
| Reliability (uptime/monitoring) | FAIL (no monitoring — see A-LIVE-03)                   |
