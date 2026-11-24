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

### A-PERF-01 (P2) — No load, latency, or Core Web Vitals evidence exists

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
- **Status:** CONFIRMED (absence verified by search).

### A-PERF-02 (P2) — Scale benchmark (100/1k/10k sites) never executed against a real DB

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

### A-PERF-03 (P3) — All 75 routes are dynamic; no caching headers for pages

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

### A-PERF-04 (P3) — Unit suite is import-bound and slow off CI (159–190s)

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

### A-PERF-05 (P3) — No DB query-plan evidence for the hot paths

- **Evidence:** dashboard aggregation, portfolio loader, and scheduler
  input queries have no recorded `EXPLAIN ANALYZE` output; indexes
  were reviewed statically in Phase 3 only.
- **Impact:** a missing index on a hot path would only show up under
  real data volume.
- **Correction:** capture `EXPLAIN ANALYZE` for the dashboard query
  set and scheduler inputs at 1k/10k scale (with A-PERF-02).
- **Status:** CONFIRMED (absence).

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
