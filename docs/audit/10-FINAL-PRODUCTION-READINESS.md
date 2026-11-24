# 10 — Final Production Readiness Assessment

Audit date: 2026-11-23. Auditor: independent audit (coordinator synthesis
of Phases 0–9). Repo: https://github.com/zuhandeveloper/metricflock,
branch `main`, HEAD `6e6d2b21` (CI #207 SUCCESS).

## 10.1 Method and honesty limits

- Every phase doc (00–09) was produced from current source, re-running
  what the sandbox can run. Prior audit docs were NOT trusted; claims
  were re-derived. Where the sandbox cannot execute (no Postgres, no
  Redis, no Docker, no live browser, no live Google account), findings
  are code-traced CONFIRMED paths or POTENTIAL risks — never live
  exploitation proofs. Those limits are stated per finding, not hidden.
- Measured locally (real runs, exit codes recorded in 00-BASELINE.md):
  format ✓, lint ✓, `pnpm audit --prod` clean ✓, typecheck 8/8 ✓,
  build 2/2 ✓, unit tests 196/196 with `--hookTimeout=60000`
  (99.23/92.98/96.87/100 coverage — narrow scope, see A-COV-01),
  production build exit 0 (75 routes, all dynamic), live
  `/api/health` → `{"status":"ok"}`, login renders, Vercel production
  READY on HEAD.
- The full unit suite fails locally on the DEFAULT 10s hook timeout
  (one test, `rate-limit-failclosed`, beforeAll timeout — A-BASE-01);
  it passes in isolation and in CI. This is a flake, not a product
  defect, but it is real.
- **No P0 was found by static review. That is not proof no P0 exists:**
  dynamic auth/IDOR exploitation, live DB concurrency, and live
  provider behavior were NOT RUN at audit time. **Update 2026-11-23
  (dynamic verification retry):** after the user enabled direct
  database protocols in Muse settings, the key P1s were executed
  against the real database with a local app server (scratch orgs
  only) — A-SEC-01, A-DB-01, A-DB-02, A-SEC-02 confirmed by
  execution; A-DB-03 and A-WRK-01 refuted/downgraded; A-GGL-01's
  parser half confirmed by execution; A-LIVE-01 confirmed live.
  Still NOT RUN: anything needing Redis/worker, live Google APIs,
  load testing, and authenticated production workflows. A P0 still
  cannot be excluded for the unexecuted areas.

## 10.2 Finding counts

| Doc                          | P0    | P1     | P2     | P3     | Total   |
| ---------------------------- | ----- | ------ | ------ | ------ | ------- |
| 00 Baseline                  | 0     | 0      | 0      | 2      | 2       |
| 01 Security                  | 0     | 3      | 6      | 11     | 20      |
| 02 API / Functional          | 0     | 1      | 5      | 12     | 18      |
| 03 Database                  | 0     | 2      | 11     | 5      | 18      |
| 04 Google integrations       | 0     | 3      | 12     | 7      | 22      |
| 05 Workers & scalability     | 0     | 2      | 9      | 9      | 20      |
| 06 Frontend & UX             | 0     | 2      | 4      | 14     | 20      |
| 07 Live production           | 0     | 1      | 3      | 1      | 5       |
| 08 Performance & reliability | 0     | 0      | 2      | 3      | 5       |
| 09 Test coverage & quality   | 0     | 4      | 6      | 6      | 16      |
| **Total**                    | **0** | **18** | **58** | **70** | **146** |

Known overlaps (same underlying issue counted in two docs — do not
double-fix): A-SEC-01 = A-WRK-02 (DLQ not tenant-scoped);
A-API-06 overlaps A-WRK-01 (hourly sync jobId dedup);
A-BASE-02 = A-COV-01 (coverage gate scope). Unique issues: **143**.
Counts updated 2026-11-23 after dynamic verification: A-DB-03 P1 → P2,
A-WRK-01 P1 → P3; totals unchanged, severity mix shifted.

## 10.3 Per-category assessment

Rule used: FAIL = a P1 (or a confirmed critical gap) touches the
category; PASS = no P1, P2 gaps noted; NOT RUN = not exercised live.

| Category                  | Verdict | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication            | FAIL    | No step-up auth on destructive routes (A-SEC-02, P1, CONFIRMED-BY-EXECUTION 2026-11-23: a 30-day-old session minted/revoked an API key and exported the org); seed SUPER_ADMIN footgun (A-SEC-03, P1 POTENTIAL); rate-limit identity spoofable off-Vercel (A-SEC-05, P2). Sound parts verified: scrypt, email-verification gate, PKCE S256, HMAC state, refresh lock + fencing.                                                                         |
| Authorization             | FAIL    | Cross-tenant DLQ read + requeue (A-SEC-01, P1 CONFIRMED-BY-EXECUTION 2026-11-23); 19/52 routes bypass the error contract (A-API-02, P2).                                                                                                                                                                                                                                                                                                                |
| Tenant isolation          | FAIL    | A-SEC-01 / A-WRK-02 (P1 CONFIRMED-BY-EXECUTION 2026-11-23). All other routes verified org-scoped; cache/snapshot keys org-scoped.                                                                                                                                                                                                                                                                                                                       |
| API security              | FAIL    | 47/52 routes have no rate limit (A-SEC-05/A-API-05, P2); 19 routes bypass `withApiErrors` (A-API-02, P2); no per-route timeouts (A-GGL-03, P1).                                                                                                                                                                                                                                                                                                         |
| Database integrity        | FAIL    | Non-atomic transfer lifecycle (A-DB-01, P1, CONFIRMED-BY-EXECUTION 2026-11-23: double complete + cancel/complete resurrection); last-admin guard race (A-DB-02, P1, CONFIRMED-BY-EXECUTION: concurrent mutual deletes left an org with 0 admins); concurrent primary mapping collides as a clean 409, not a 500 (A-DB-03, downgraded to P2 on dynamic verification). Schema itself verified equivalent to migrations (25/25 tables, 9/9 enums, 42 FKs). |
| Google OAuth              | FAIL    | Token refresh unlocked with no Redis (A-GGL-02, P1); no timeouts on googleapis calls (A-GGL-03, P1). Scopes, state, PKCE, envelope verified sound.                                                                                                                                                                                                                                                                                                      |
| GA4                       | NOT RUN | Code + math reviewed (totals, sampling, truncation correct); no live data confirmed in production.                                                                                                                                                                                                                                                                                                                                                      |
| Search Console            | NOT RUN | Code + math reviewed (impression-weighted position correct); 2026-11-21 live verification is history only, not re-verified.                                                                                                                                                                                                                                                                                                                             |
| AdSense                   | NOT RUN | Code reviewed; live earnings unverified; portfolio RPM invents 0 on null earnings (A-GGL P2, in doc 04).                                                                                                                                                                                                                                                                                                                                                |
| Ad Manager                | FAIL    | Reporting calls a non-existent API shape — non-functional (A-GGL-01, P1; parser half CONFIRMED-BY-EXECUTION 2026-11-23).                                                                                                                                                                                                                                                                                                                                |
| Workers and queues        | FAIL    | Worker not deployed in production (A-LIVE-04, P2) AND code P1s: DLQ cross-tenant (A-WRK-02, CONFIRMED-BY-EXECUTION), report re-mail loop (A-WRK-03). A-WRK-01 (sync dedup no-op) REFUTED on dynamic verification 2026-11-23 — duplicate manual sync returns 409 via the unique `externalId`, no orphan PENDING rows (now P3).                                                                                                                           |
| Frontend functionality    | FAIL    | Systemic missing duplicate-submit guards (A-FE-01, P1); websites list silently capped at 100 (A-FE-02, P1).                                                                                                                                                                                                                                                                                                                                             |
| Accessibility             | PASS    | Light-mode axe gate passes on 12 signed-in pages; skip link, labels, focus verified. Gap: dark-mode contrast fails 4.5:1 (A-FE-04, P2); axe runs light-mode only.                                                                                                                                                                                                                                                                                       |
| Performance               | NOT RUN | No load/latency/Core Web Vitals measurements exist (A-PERF-01, P2); scale benchmark never run on a real DB (A-PERF-02, P2). Build/bundle measured OK (1.3 MB client JS).                                                                                                                                                                                                                                                                                |
| Deployment configuration  | PASS    | Vercel READY on HEAD; env vars set; security headers configured; SHA-pinned workflows (one exception: labeler, A-SEC-06, P2).                                                                                                                                                                                                                                                                                                                           |
| Backup and recovery       | NOT RUN | Provider PITR assumed; CI restore drill exists per repo docs — not re-verified live.                                                                                                                                                                                                                                                                                                                                                                    |
| CI/CD and dependencies    | FAIL    | Coverage gate measures 8 files, not the repo (A-COV-01, P1); ESLint lints no `.ts`/`.tsx` (A-COV-09, P2); labeler unpinned (A-SEC-06, P2). `pnpm audit` clean; CI #207 green.                                                                                                                                                                                                                                                                           |
| Live website verification | FAIL    | Readiness persistently 503, cause `redis: down` (A-LIVE-01, P1 CONFIRMED-BY-EXECUTION 2026-11-23, two checks 2 min apart); og.png/favicon 404 (A-LIVE-02, P2); no monitoring (A-LIVE-03, P2); authenticated workflows BLOCKED (no test account).                                                                                                                                                                                                        |

## 10.4 The P1 findings (18 active after dynamic verification 2026-11-23; 2 downgraded — see items 7 and 11)

1. **A-SEC-01 / A-WRK-02** — DLQ cross-tenant read + requeue (`api/sync/failed/route.ts:15-17`, `api/sync/requeue/route.ts:20`, `api/metrics/route.ts:24-33`). CONFIRMED by coordinator re-read: `AnalyticsSyncJob` has no `organizationId`; queries filter only by status/id. **CONFIRMED-BY-EXECUTION 2026-11-23** (org A's admin listed org B's FAILED job with payload; requeue reached `enqueue()`).
2. **A-SEC-02** — No step-up/fresh-session check on destructive routes (`packages/auth/src/server.ts` sets `session.freshAge: 15min` but no app route enforces it). **CONFIRMED-BY-EXECUTION 2026-11-23** (30-day-old session minted/revoked an API key and exported the org).
3. **A-SEC-03** — Seed creates `demo@example.com`/`ChangeMe123!` SUPER_ADMIN unless `NODE_ENV === "production"` (`packages/db/src/seed.ts:9-21`); prod exposure unknown. (Note: during dynamic verification the DB survey found **no** `demo@example.com` user — the seeded org instead has `admin@csofts.com` as SUPER_ADMIN. A-SEC-03's prod exposure remains unconfirmed as a live risk, but the footgun stands.)
4. **A-API-01** — same as #1 (cross-tenant sync job access), filed under API.
5. **A-DB-01** — Transfer accept/complete/cancel/reject non-atomic check-then-act; `complete`'s `$transaction` never re-guards status (`api/transfers/[id]/complete/route.ts:40-54`). **CONFIRMED-BY-EXECUTION 2026-11-23** (double complete both 200 + two audit rows; cancel/complete race resurrected transfers in 3 of 5 valid rounds; one round ended CANCELLED with `completedAt` set and the website moved).
6. **A-DB-02** — Last-SUPER_ADMIN guard is count-then-delete, no transaction/lock (`api/members/[id]/route.ts:78-88`). **CONFIRMED-BY-EXECUTION 2026-11-23** (concurrent mutual deletes left a scratch org with 0 SUPER_ADMINs; the second delete's audit write failed with P2003, so it is also unaudited).
7. ~~**A-DB-03** — Concurrent primary mappings violate the partial unique index → 500~~ — **DOWNGRADED to P2 on dynamic verification 2026-11-23:** the collision is real (6 parallel maps → 2× 409 `conflict`) but the outcome is a clean 409, not a 500, and exactly one primary remains. See doc 03.
8. **A-GGL-01** — Ad Manager reporting calls a non-existent API shape (`packages/google/src/ad-manager.ts:130-158`); non-functional. Parser half **CONFIRMED-BY-EXECUTION 2026-11-23** (a real Operation response parses to `{parsed:false, rows:[], totals:{}}`).
9. **A-GGL-02** — Token refresh unlocked when `REDIS_URL` unset (`packages/google/src/tokens.ts:62-75`); no-Redis presented as supported.
10. **A-GGL-03** — No timeout on any googleapis call (GA4/SC/AdSense/OAuth); no `maxDuration` on routes.
11. ~~**A-WRK-01** — Manual "Sync now" reuses an hour-bucket jobId; BullMQ dedupes it, so repeat clicks no-op and orphan the PENDING row~~ — **REFUTED on dynamic verification 2026-11-23, downgraded to P3:** the duplicate create hits the unique `externalId` (409 `conflict`); only one row exists and it is FAILED, not orphaned PENDING. See doc 05.
12. **A-WRK-02** — same as #1 (DLQ scope), filed under Workers.
13. **A-WRK-03** — Weekly-report send loop has no per-recipient try/catch; SMTP failure mid-loop re-mails earlier recipients (`apps/worker/src/report.ts:104-112`).
14. **A-FE-01** — Systemic missing duplicate-submission guard; shared `Button` has no `disabled` prop; only 2 of ~20 forms guard on `busy`.
15. **A-FE-02** — Websites list silently caps at 100 rows, no pagination/count (`websites/page.tsx`).
16. **A-COV-01** — Coverage gate is vacuous: measures 8 files under `apps/web/src/lib/`; routes, packages, worker unmeasured.
17. **A-COV-02** — `packages/auth/src/tenant.ts` (all 8 assert/visibility functions) has zero unit tests; tenant isolation rests on smoke (CI-only).
18. **A-COV-03** — `transfer.test.ts` is tautological; `lib/transfers.ts` core functions untested; cancel/reject routes never exercised.
19. **A-COV-04** — ≥19 of 52 route handlers never exercised by any suite (8/9 analytics routes, all 5 v1 routes, insights, health, send-test, logout, invite accept, invite/[id], transfer cancel/reject).
20. **A-LIVE-01** — Readiness endpoint persistently returns HTTP 503, cause `redis: down` (db ok). **CONFIRMED-BY-EXECUTION 2026-11-23** (two live checks ~2 min apart).

## 10.5 Executive summary (the 10 items)

1. **Overall production readiness:** NOT READY — high-priority issues remain (decision 2 of 4; see §10.6). The codebase is well-built and heavily tested at the unit level, but 18 P1s — including a cross-tenant data exposure **confirmed by live execution** — plus an undeployed worker, a persistently failing readiness probe (Redis down), and unverified live Google data mean it cannot honestly be called production-ready.
2. **Confirmed P0/P1/P2/P3 findings:** P0: 0; P1: 18; P2: 58; P3: 70; total 146 (143 unique after 3 overlaps). Dynamic verification 2026-11-23 confirmed 5 P1s by execution (A-SEC-01, A-SEC-02, A-DB-01, A-DB-02, A-LIVE-01), partially confirmed A-GGL-01, and refuted/downgraded 2 (A-DB-03 → P2, A-WRK-01 → P3). No P0 was found; the areas still NOT RUN (Redis/worker runtime, live Google APIs, load testing) still cannot exclude one.
3. **Critical security vulnerabilities:** none at P0. The most serious confirmed issue is cross-tenant DLQ read/requeue (A-SEC-01, P1, CONFIRMED-BY-EXECUTION). No SQL injection, XSS, SSRF, open redirect, or secret-leak path was found; crypto (AES-256-GCM + AAD + rotation), OAuth state/PKCE, scrypt, and CSP nonce all verified sound.
4. **Broken or incomplete functionality:** Ad Manager reporting is non-functional (wrong API shape); websites list silently truncates at 100; weekly reports can duplicate-mail; transfer lifecycle has TOCTOU races (confirmed live: double completion, resurrection, inconsistent CANCELLED-with-completedAt state); last-admin deletion can leave an org admin-less (confirmed live); worker/scheduled behavior is absent in production (not deployed); production readiness probe fails (Redis down).
5. **Cross-tenant / authorization loopholes:** A-SEC-01 (DLQ + metrics, CONFIRMED-BY-EXECUTION); everything else reviewed is org-scoped. Authz matrix: 52 routes read; SUPER_ADMIN/TEAM_ADMIN/TEAM_MEMBER roles verified in code (the brief's ADMIN/MEMBER role names do not exist in code).
6. **Failed tests:** locally, the full unit suite fails on the default 10s hook timeout (A-BASE-01, flake — passes in isolation and in CI). In CI #207: 196/196 unit, smoke ALL CHECKS PASSED, e2e 24/24. One timing-flaky test in the DB phase (`refresh-lock.test.ts`, 60ms deadline — A-GGL-21, P3).
7. **Untested or blocked areas:** ≥19/52 routes never exercised; tenant.ts zero unit tests; worker 692 LOC, 0 tests; coverage gate measures 8 files; smoke + e2e run in CI only; live DB concurrency now EXECUTED for the top findings (see §10.7), but Redis/worker runtime, live Google APIs, load testing, and authenticated production workflows remain NOT RUN/BLOCKED.
8. **Live website results:** `/api/health` ok; login renders; Vercel READY on HEAD; og.png/favicon 404; `/api/health/ready` **persistently 503** (`db: ok, redis: down`, confirmed twice 2 min apart); no monitoring configured.
9. **Performance results:** no measurements exist (no load tests, no p50/p95/p99, no Core Web Vitals, no query plans, scale benchmark never run on a real DB). Build/bundle measured OK; dashboard queries are bounded (page size 50).
10. **Exact next steps:** see `11-REMEDIATION-PLAN.md` — P1s first (DLQ scoping, transfer atomicity, Ad Manager rewrite or removal, refresh-lock fail-closed without Redis, timeouts, step-up auth, seed guard, report loop guard, duplicate-submit guards, websites pagination, coverage gate scope, tenant.ts tests, transfer tests, route coverage, restore Redis / fix readiness probe), then worker deployment, then P2s.

## 10.6 Final release decision

**Decision: 2 — NOT READY — HIGH-PRIORITY ISSUES REMAIN.**

Reasoning: 18 P1 findings, five of which are now CONFIRMED-BY-EXECUTION
(A-SEC-01 cross-tenant read + requeue, A-SEC-02 stale-session
privilege actions, A-DB-01 transfer double-completion and
resurrection, A-DB-02 admin-less org via concurrent deletes,
A-LIVE-01 persistent readiness 503 on a down Redis), plus a
non-functional provider integration (Ad Manager), and an undeployed
worker that leaves headline features (scheduled sync, health
alerts, weekly reports) operationally dead. Zero P0s were
found, and the engineering quality underneath is high (clean audit,
green CI, strong crypto and OAuth controls, good test discipline at
the unit level) — but "production-ready" requires the P1s closed and
the remaining BLOCKED/NOT RUN areas (Redis/worker runtime, live
Google data, load testing) actually exercised. The current live
deployment should be treated as controlled/staging-grade: do not
expand production usage, do not onboard additional tenants, and do
not claim production readiness until the P1 remediation is verified
by a re-audit of the affected areas. Dynamic verification moved
the evidence (2 findings downgraded/refuted, 5 confirmed live) but
did not move the decision: the confirmed P1s are the same ones that
drove it.

"100% production ready" is not claimed anywhere in this audit, and
must not be claimed on the basis of a green build or green CI alone.

## 10.7 Dynamic verification 2026-11-23 — first attempt BLOCKED, retry EXECUTED

**First attempt (evening, before the user changed settings): BLOCKED.**
The user supplied the development database URL and asked for the NOT
RUN items to be executed against the real database. The attempt
stopped at step 1 (connectivity): TCP to `db.prisma.io:5432` was
intercepted by the sandbox egress proxy, which returned the banner
`muse: Database connections is turned off for this assistant. To
allow it, ask the user to open Muse settings -> Permissions ->
Direct network protocols and switch databases from Deny to Ask.`
`prisma migrate status` failed with `Could not parse schema engine
response`; raw `pg` connections failed with `There was an error
establishing an SSL connection`. No seed was run and no scratch data
was created; no real data was touched.

**Retry (2026-11-23 ~23:55–00:07 UTC, after the user enabled direct
database protocols, Deny → Ask): EXECUTED.** Connectivity confirmed
(raw socket SSL byte `S`; `pg` connected to PostgreSQL 17.2;
`_prisma_migrations` shows all **13 migrations APPLIED** — schema
state re-confirmed, matching the user's own 2026-11-23 run). A local
`next start` server was booted on port 3200 against the real database
(`DATABASE_URL` via env only, never written to disk; dummy
`SESSION_SECRET` and dummy encryption key; `EMAIL_LOG_PREVIEW=true`
so verification URLs surfaced in the local log). Three scratch orgs
(A, B, C) were created via the public sign-up API with verified
emails; all scratch data was deleted afterwards and the DB was
verified back to its pre-test state (3 orgs, 3 users, 5 websites, 9
pre-existing PENDING jobs, 3 Google connections — real data
untouched). Results, per finding:

- **A-SEC-01 — CONFIRMED-BY-EXECUTION:** org A's SUPER_ADMIN listed
  org B's FAILED sync job (with payload) via `GET /api/sync/failed`
  and saw it counted in `GET /api/metrics`; `POST /api/sync/requeue`
  reached `enqueue()` and failed only on missing Redis (503
  `queue_unavailable`), not on authorization.
- **A-SEC-02 — CONFIRMED-BY-EXECUTION:** a session aged to 30 days
  minted an API key (201), deleted it (200), and exported the org
  (200) — no freshness check anywhere.
- **A-DB-01 — CONFIRMED-BY-EXECUTION:** two concurrent completes both
  200 with two audit rows; 3 of 5 valid cancel/complete race rounds
  ended COMPLETED despite cancel returning 200; one round ended
  CANCELLED with `completedAt` set and the website moved.
- **A-DB-02 — CONFIRMED-BY-EXECUTION:** concurrent mutual deletes of
  a 2-admin org left **0 SUPER_ADMINs** (0 users); the second delete's
  audit write failed (P2003 on the concurrently-deleted actor), so
  the deletion is unaudited.
- **A-DB-03 — PARTIALLY CONFIRMED, downgraded P1 → P2:** collisions
  occur (6 parallel maps → 2× 409 `conflict`) but the outcome is a
  clean 409, not a 500, and exactly one primary remains.
- **A-GGL-01 — parser half CONFIRMED-BY-EXECUTION:** a realistic
  `reports:run` Operation response parses to
  `{parsed:false, rows:[], totals:{}}`. Live execution still NOT RUN
  (no Ad Manager network).
- **A-WRK-01 — REFUTED, downgraded P1 → P3:** duplicate manual sync
  in the same hour returns 409 `conflict` via the unique
  `externalId`; only one row exists (FAILED, not orphaned PENDING).
- **A-LIVE-01 — CONFIRMED-BY-EXECUTION (live browser task,
  read-only):** `/api/health/ready` returned 503 twice ~2 min apart,
  `{"status":"not_ready","checks":{"db":"ok","redis":"down"}}`;
  `/api/health` 200; `/login` renders; headers Grade A+;
  `/og.png` and `/favicon.ico` still 404.
- **Unit suite re-run:** 38 files / 196 tests pass, coverage
  99.23 / 92.98 / 96.87 / 100 (same as CI #207).
- **Schema survey (read-only):** 13/13 migrations applied; no
  `demo@example.com` user exists in this database (A-SEC-03's prod
  exposure remains unconfirmed as a live risk; the seed footgun
  stands).

**Still BLOCKED / NOT RUN after the retry:** anything needing Redis
or the worker (queue execution, scheduler ticks, report re-mail
loop, refresh-lock contention, the with-Redis half of A-WRK-01);
live Google APIs (GA4/AdSense/Ad Manager networks); load/latency/
Core Web Vitals; authenticated production workflows (no test
account); Playwright e2e (needs the seeded demo admin, which does
not exist in this database — `demo@example.com` absent — and must
not be created here).

**Decision impact:** unchanged — **decision 2 — NOT READY**. The
evidence moved (5 P1s confirmed by execution, 2 downgraded), but
the confirmed P1s are the ones that drove the decision.

## 10.8 Stage 1 remediation (local, unpushed — 2026-11-24)

After the owner approved remediation, all 16 Stage 1 P1 items were
implemented locally (no commit, push, or deploy; see
`11-REMEDIATION-PLAN.md` "Stage 1 status" for the per-row record).
Unit suite grew from 196 to **387 tests (50 files), all passing**;
format, lint, typecheck (8/8), and production build are green.
No migration was added. The coverage gate now measures the whole repo
(155 files, was 8) with thresholds unchanged — and **fails honestly**
(42.58/36.64/38.56/44.02 vs 90/80/90/90): closing it needs component
tests, worker tests, and remaining route tests. Smoke + e2e were not
run locally (CI only). Live Ad Manager verification is still pending
(fixture-tested only); the production readiness 503 is an owner action
(Redis restore or `REDIS_URL` removal in Vercel).

**The release decision is unchanged (2 — NOT READY).** It moves only
after re-audit against the §11.2 gates: CI green including smoke + e2e
on the remediated code, a multi-org IDOR suite in CI, the worker
deployed, `/api/health/ready` 200 for 7 days with monitoring live,
GA4/AdSense live data confirmed, load/benchmark evidence, and the
coverage gate measuring the whole repo and passing.

## 10.9 Coverage gap closure (local, unpushed — 2026-11-24)

After the owner chose to close the coverage gap before pushing, the
gate was closed locally (no commit, push, or deploy). Two corrections
to the Stage 1 record: the gate actually measured **155 files, not the
whole repo** — the worker include glob (`../../apps/worker/...`) never
matched, because Vitest matches coverage globs against
`path.relative(root, file)` (`../worker/...`, one `..`) and picomatch
does not normalize `..`; fixed to `../worker/src/**/*.ts`, verified
worker files now in coverage (158 files). True Stage 1 baseline was
therefore **40.74/35.29/37.30/42.16**, not 42.58/36.64/38.56/44.02.
Closure work (4 agents: renderer + components, worker, routes + lib,
google + db) added jsdom + @testing-library/react + jest-dom, component
tests (275), worker tests (53, all three worker files 100%),
route/lib tests (185), google/db tests (135). Unit suite grew from 387
to **1,035 tests (97 files), all passing**; final local gate run
(Kai's own verification): **96.8% stmts / 90.19% branches / 93.92%
funcs / 98.29% lines vs 90/80/90/90 — GREEN with margin on all four**
(+6.8 / +10.19 / +3.92 / +8.29). Format, lint (incl. boundary checks),
typecheck, and production build are green. No thresholds lowered, gate
not narrowed, no test deleted or weakened, no migration added.
Small follow-ups by the coordinator during verification: worker package
exports (`./index`, `./scheduler`) added and worker tests switched from
relative imports to `@metricflock/worker/*`, plus a `bullmq`
resolve.alias in vitest.config.ts (same pattern as googleapis/ioredis)
so `vi.mock("bullmq")` intercepts the worker's copy. Remaining
uncovered lines are characterized in the agents' reports (defensive
`if (busy) return` guards unreachable via disabled buttons, a few dead
code paths in sync.ts/ad-manager.ts, and the routes agent's 42-statement
punch-list of coverable `req.json().catch` fallbacks). Smoke + e2e were
not run locally (CI only) — they are the remaining local-verification
gap; CI must confirm them on push.
