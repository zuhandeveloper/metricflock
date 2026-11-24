# 12 — Complete Audit Summary (everything, in one place)

Date: 2026-11-23. Repo: https://github.com/zuhandeveloper/metricflock,
branch `main`, HEAD `6e6d2b21` (CI #207 SUCCESS). Auditor: independent audit,
Phases 0–10, plus dynamic verification retry against the real database.
All audit docs are local only — NOT pushed, NOT committed.

**Headline: NOT READY — HIGH-PRIORITY ISSUES REMAIN (decision 2 of 4).
Findings: 0 P0, 18 P1, 58 P2, 70 P3 = 146 entries, 143 unique
(3 overlaps: A-SEC-01 = A-WRK-02, A-API-06 overlaps A-WRK-01,
A-BASE-02 = A-COV-01).**

## 1. What was tested — complete list

### 1.1 Baseline (Phase 0, doc 00)

Inventory counted from source: 215 source files (.ts/.tsx), 52 API route
files, 25 Prisma models, 9 enums, 13 migrations, 20 app pages,
38 unit test files, 3 e2e spec files + auth setup, 0 TODO/FIXME/XXX/HACK
markers. Workspaces: apps/web, apps/worker; packages db, auth, google,
jobs, shared. Integrations: Google OAuth, GA4, Search Console, AdSense,
Ad Manager, SMTP, Redis (BullMQ/cache), Postgres (Prisma), Vercel.
Background jobs: BullMQ sync queues (per-provider) + scheduled-report;
scheduler tick plans realtime (300s), historical (45m), SC (8h),
AdSense (3h), health (1h), weekly reports.

Baseline commands (all run locally, exit codes recorded):
`pnpm format:check` 0 (Prettier-clean); `pnpm lint` 0 (boundary checks
passed); `pnpm audit --prod` 0 (no known vulnerabilities); `turbo run
typecheck` 0 (8/8); `turbo run build` 0 (2/2); unit suite 196/196 with
`--hookTimeout=60000` (99.23/92.98/96.87/100 coverage — narrow scope,
see A-COV-01); full unit suite FAILS on the default 10s hook timeout
(A-BASE-01: `rate-limit-failclosed.test.ts` beforeAll timeout, 37/38
files passed, 194 passed, 2 skipped, 189.79s). Production build exit 0
(75 routes, all dynamic). Migration↔schema equivalence verified:
25/25 tables, 9/9 enums, 42 FKs. Production DB confirmed in sync by the
owner 2026-11-23 ("13 migrations found, Database schema is up to date!").

### 1.2 Security (Phase 1, doc 01)

Read and traced: signup, login, logout, email verification, password
reset, session create/expire/refresh/revoke, OAuth initiation + callback,
Google account linking, account recovery, invitation acceptance, user
deletion. Checked: password hashing (scrypt — sound), password validation
(min 12), session security, cookie flags, CSRF, OAuth state (HMAC
single-use — sound), PKCE S256 (sound), replay protection, session
fixation, account enumeration, brute-force/rate limiting, token expiry/
revocation, email verification enforcement. Authorization matrix built
for Org Owner / Org Admin / Team Admin / Team Member / Website Viewer /
unauthenticated across organizations, teams, websites, users, Google
connections, properties, analytics, reports, invitations, API keys,
exports, audit records — every route read for org scoping. Injection
surface checked: no raw SQL, no `dangerouslySetInnerHTML`, no SSRF,
no open redirects found. Secrets/crypto: AES-256-GCM token envelope +
AAD + rotation (sound), no secret leaks found in logs/responses/bundles.
Config: nonce CSP (sound), HSTS, CORS, X-Frame-Options, cookie config.
Supply chain: `pnpm audit --prod` clean; workflows SHA-pinned except
labeler (A-SEC-06).

### 1.3 API & backend (Phase 2, doc 02)

All 52 API routes inventoried (method, auth, authz, validation, DB ops,
external deps, error handling, rate limit, response format, coverage).
Analytics (9), auth (3 + better-auth catch-all), Google (6), websites
(5), teams (3), members (3), transfers (4), sync (3), reports (2),
organization (2), insights (1), integrations/health (1), invites/accept
(1), health (1), health/ready (1), metrics (1), api-keys (2), public
API v1 (5). Each route checked for: valid request, missing auth,
insufficient permission, invalid input, missing fields, unexpected
fields, invalid/nonexistent/cross-tenant IDs, duplicates, concurrency,
DB failure, external API failure, timeout, malformed response,
rate-limit exhaustion, internal exception. Status codes, response
schemas, sensitive-data exposure, pagination, filtering, sorting,
validation, idempotency all reviewed in code.

### 1.4 Database (Phase 3, doc 03)

Full Prisma schema + all 13 migrations read. Verified: PKs, FKs (42),
unique + composite unique constraints, required/nullable fields,
cascade/restrict behavior, referential integrity, indexes, query
patterns, transaction boundaries, race conditions, concurrent updates,
ownership, tenant isolation, soft/hard deletion, retention. Tested in
code: fresh migration, upgrade path, duplicate prevention, concurrent
writes, partial transaction failures, ownership changes, website
transfers, connection deletion, user/org deletion. N+1 patterns found
(A-DB-11). No DB query plans run (no staging DB at audit time).

### 1.5 Google integrations (Phase 4, doc 04)

OAuth lifecycle traced (auth URL, scopes, state, PKCE, callback,
code exchange, token encryption, refresh storage, refresh, reauth,
disconnect, revoke). GA4, Search Console, AdSense, Ad Manager reviewed
independently: discovery, pagination, date ranges, dimensions/metrics,
aggregation math recomputed from code (GA4 totals correct; SC
impression-weighted position correct; AdSense RPM bug A-GGL-05),
realtime, missing permissions, quota errors, empty responses, timezone
handling. Reliability: timeout, retry, exponential backoff, rate
limiting, invalid/revoked/expired credentials, malformed JSON,
unexpected structures, partial outages, quota exhaustion — checked in
code with fixtures. Live Google APIs NOT RUN (no live account).

### 1.6 Workers, queues, scheduling (Phase 5, doc 05)

Worker (692 LOC), scheduler, BullMQ queues, DLQ, metrics reviewed:
job creation/persistence/processing/completion, failure handling,
retries, backoff (jitter), idempotency, concurrency, locking, crash
recovery, dead-letter handling, duplicate prevention, progress,
cleanup, expiration, shutdown. Failure scenarios traced in code:
worker crash, Redis interruption, DB interruption, provider outage,
concurrent duplicates, lock expiry, retry exhaustion, restart during
processing, large queues, partial completion. One failed website vs
others, tenant visibility of jobs — checked. Scheduler load tests
(100/1,000/10,000 websites) NOT RUN — no staging env, and must not
load production provider accounts.

### 1.7 Frontend & UX (Phase 6, doc 06)

Every page and major component inspected; interactions checked, not
just rendering: navigation, forms, validation, buttons, dropdowns,
modals, tables, filters, search, pagination, date pickers, charts,
tabs, settings, org/team/website switching, invitations, Google
connection, property mapping, reports, exports, notifications. Each
control checked for: intended action, loading state, success, failure,
duplicate-submit prevention, empty data, slow responses, unauthorized
actions, post-refresh behavior. Broken links/images, console errors,
hydration errors, runtime exceptions, stale state, race conditions,
chart values, currency/date formatting — reviewed. Responsive layouts
(desktop/laptop/tablet/mobile) reviewed in code. Accessibility: keyboard
navigation, focus management, accessible names, form labels, contrast,
screen-reader semantics, dialog accessibility, axe violations — axe
gate passes on 12 signed-in pages in light mode (CI); dark-mode
contrast fails (A-FE-04).

### 1.8 Live website & production (Phase 7, doc 07)

Live read-only checks on https://metricflock.bond (2026-11-23,
16:52–16:56 MST, browser task, no sign-in, nothing modified):
`/` → 307 to `/login` (200, renders fully: logo, "Sign in to
MetricFlock", Continue with Google, email/password fields, Forgot
password link); `/api/health` → 200 `{"status":"ok"}`; `/api/health/ready`
→ 503 TWICE ~2 min apart `{"status":"not_ready","checks":{"db":"ok",
"redis":"down"}}`; security headers Grade A+ (securityheaders.com:
nonce CSP, HSTS, X-Frame-Options DENY, nosniff, referrer-policy,
permissions-policy); `/og.png` and `/favicon.ico` → 404 (app's own
"Page not found" page); no visible console errors on /login
(rendered-page check only — DevTools console pane not directly
readable). Authenticated production workflows BLOCKED (no authorized
test account; real customer data must not be touched). Deployment
config: Vercel READY on HEAD, env vars set, no error monitoring
configured (A-LIVE-03), worker not deployed (A-LIVE-04).

### 1.9 Performance & reliability (Phase 8, doc 08)

No load/latency/Core Web Vitals measurements exist (A-PERF-01).
No p50/p95/p99, no error rate, no throughput, no memory/CPU numbers
— nothing was load-tested, by design (no staging env; production must
not be load-tested). Build/bundle measured OK (1.3 MB client JS).
Dashboard queries bounded (page size 50). No DB query-plan evidence
for hot paths (A-PERF-05). Unit suite import-bound and slow off CI
(159–190s, A-PERF-04).

### 1.10 Test coverage & quality (Phase 9, doc 09)

Coverage measured, not just counted: 38 unit test files, 196 tests;
CI #207 green (196/196, smoke ALL CHECKS PASSED, e2e 24/24). Quality
review found: coverage gate measures 8 files only (A-COV-01);
tenant.ts zero unit tests (A-COV-02); transfer tests tautological
(A-COV-03); ≥19/52 routes never exercised (A-COV-04); worker 692 LOC
zero tests (A-COV-05); token refresh/OAuth/Google client untested in
unit (A-COV-06); Redis cache + env parsing untested (A-COV-07); 6 of 8
Zod schemas untested (A-COV-08); ESLint lints no .ts/.tsx (A-COV-09);
barrel mocks can hide wiring regressions (A-COV-10); weak assertions
inventoried (A-COV-11); flakiness/speed risks (A-COV-12); thin UI/e2e
journey coverage (A-COV-13); DB write paths untested in unit
(A-COV-14); no per-file thresholds (A-COV-15); auth email paths
untested (A-COV-16).

### 1.11 Dynamic verification (retry, real DB + local app server)

First attempt BLOCKED by sandbox proxy (database protocols Deny).
After the user enabled them (Deny → Ask): connected to PostgreSQL
17.2, `_prisma_migrations` confirmed all 13 migrations APPLIED.
Local `next start` on port 3200 against the real DB (env-only
DATABASE_URL, dummy secrets, `EMAIL_LOG_PREVIEW=true`). Three scratch
orgs (A, B, C) created via public sign-up API; all scratch data
deleted afterwards; DB verified back to pre-test state (3 orgs,
3 users, 5 websites, 9 pre-existing PENDING jobs, 3 Google
connections — real data untouched). Results in §3 below.

## 2. Where everything is (all audit documents, local only)

| Doc                                              | Contents                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `docs/audit/00-BASELINE.md`                      | Repo state, inventory, baseline command results                                     |
| `docs/audit/01-SECURITY-AUDIT.md`                | 20 findings: auth, IDOR, tenant isolation, injection, secrets, config, supply chain |
| `docs/audit/02-API-FUNCTIONAL-AUDIT.md`          | 18 findings: all 52 routes, error contract, validation, pagination                  |
| `docs/audit/03-DATABASE-AUDIT.md`                | 18 findings: schema, migrations, transactions, races, N+1, retention                |
| `docs/audit/04-GOOGLE-INTEGRATIONS-AUDIT.md`     | 22 findings: OAuth, GA4, SC, AdSense, Ad Manager, reliability                       |
| `docs/audit/05-WORKERS-AND-SCALABILITY-AUDIT.md` | 20 findings: queues, scheduler, DLQ, reports, scale                                 |
| `docs/audit/06-FRONTEND-AND-UX-AUDIT.md`         | 20 findings: pages, forms, duplicate-submit, a11y, mobile                           |
| `docs/audit/07-LIVE-PRODUCTION-AUDIT.md`         | 5 findings: live site, readiness, monitoring, worker                                |
| `docs/audit/08-PERFORMANCE-AND-RELIABILITY.md`   | 5 findings: load/latency evidence gaps                                              |
| `docs/audit/09-TEST-COVERAGE-AND-QUALITY.md`     | 16 findings: coverage quality, untested areas, flakiness                            |
| `docs/audit/10-FINAL-PRODUCTION-READINESS.md`    | Per-category verdicts, P1 list, executive summary, decision                         |
| `docs/audit/11-REMEDIATION-PLAN.md`              | Fix plan in 4 stages (Stage 1: 16 P1s), re-audit gates                              |
| `docs/audit/12-COMPLETE-SUMMARY.md`              | This file — everything in one place                                                 |

## 3. All findings — complete list

### 3.1 P1 — High (18 active; 2 downgraded during verification)

1. **A-SEC-01 / A-WRK-02 / A-API-01 — Cross-tenant DLQ read + requeue.**
   `apps/web/src/app/api/sync/failed/route.ts:15-17`,
   `api/sync/requeue/route.ts:20`, `api/metrics/route.ts:24-33`.
   Queries filter only by status/id; `AnalyticsSyncJob` has no
   `organizationId`. **CONFIRMED-BY-EXECUTION:** org A's SUPER_ADMIN
   listed org B's FAILED job with payload; requeue reached `enqueue()`
   (stopped only by no-Redis 503, not by authz).
2. **A-SEC-02 — No step-up / fresh-session check on destructive routes.**
   `session.freshAge: 15min` is set in `packages/auth/src/server.ts`
   but no app route enforces it. **CONFIRMED-BY-EXECUTION:** a 30-day-old
   session minted an API key (201), deleted it (200), and exported the
   whole org (200).
3. **A-SEC-03 — Seed creates a known-credential SUPER_ADMIN**
   (`demo@example.com` / `ChangeMe123!`) unless `NODE_ENV` is exactly
   `production` (`packages/db/src/seed.ts:9-21`). POTENTIAL — the live DB
   survey found no `demo@example.com` user (seeded org's SUPER_ADMIN is
   `admin@csofts.com`), so prod exposure is unconfirmed; the footgun
   stands.
4. **A-DB-01 — Transfer lifecycle is non-atomic check-then-act.**
   `api/transfers/[id]/complete/route.ts:40-54` — `$transaction` never
   re-guards status. **CONFIRMED-BY-EXECUTION:** two concurrent completes
   both 200 + two audit rows; 3 of 5 cancel/complete race rounds ended
   COMPLETED despite cancel returning 200; one round ended CANCELLED
   with `completedAt` set and the website moved.
5. **A-DB-02 — Last-SUPER_ADMIN guard is count-then-delete, not atomic.**
   `api/members/[id]/route.ts:78-88`. **CONFIRMED-BY-EXECUTION:**
   concurrent mutual deletes left a scratch org with 0 SUPER_ADMINs
   (0 users); the second delete's audit write failed (P2003), so it is
   also unaudited.
6. **A-GGL-01 — Ad Manager reporting calls a non-existent API shape.**
   `packages/google/src/ad-manager.ts:130-158` POSTs a report definition
   to `reports:run`; the real v1 API needs create → run → poll → fetchRows.
   Parser half **CONFIRMED-BY-EXECUTION** (realistic Operation response
   → `{parsed:false, rows:[], totals:{}}`). Live NOT RUN.
7. **A-GGL-02 — Token refresh runs unlocked whenever `REDIS_URL` is
   unset** (`packages/google/src/tokens.ts:62-75`); no-Redis is a
   documented deployment shape.
8. **A-GGL-03 — No timeout on any googleapis call** (GA4 / Search Console /
   AdSense / OAuth); no `maxDuration` on routes.
9. **A-WRK-03 — Weekly-report send loop is not per-recipient
   fault-isolated** (`apps/worker/src/report.ts:104-112`); a mid-loop
   SMTP failure duplicates mail on retry.
10. **A-FE-01 — Duplicate-submission guard missing almost everywhere:**
    `busy` only changes the label, the button stays live; shared `Button`
    has no `disabled` prop; only 2 of ~20 forms guard on `busy`.
11. **A-FE-02 — Websites list silently caps at 100 rows**, no pagination,
    no count (`websites/page.tsx`).
12. **A-COV-01 — Coverage gate measures 8 files, not the repo**
    (`apps/web/vitest.config.ts` — no `coverage.all`/`include`; the
    99.23% headline covers only `apps/web/src/lib/` files exercised by
    unit tests; all 52 routes, all packages, worker unmeasured).
13. **A-COV-02 — Tenant-isolation functions have zero unit tests**
    (`packages/auth/src/tenant.ts`, all 8 assert/visibility functions).
14. **A-COV-03 — `transfer.test.ts` is tautological**; `lib/transfers.ts`
    core functions untested; cancel/reject routes never exercised.
15. **A-COV-04 — ≥19 of 52 route handlers never exercised by any suite**
    (8/9 analytics routes, all 5 v1 routes, insights, health, send-test,
    logout, invite accept, invite/[id], transfer cancel/reject).
16. **A-LIVE-01 — Readiness endpoint persistently returns HTTP 503.**
    **CONFIRMED-BY-EXECUTION** (live, twice ~2 min apart):
    `{"status":"not_ready","checks":{"db":"ok","redis":"down"}}` —
    production has a `REDIS_URL` configured but Redis is down.

Downgraded during dynamic verification (were P1):

- **A-DB-03 → P2** — concurrent primary mappings collide, but the outcome
  is a clean 409 (6 parallel maps → 4× 200, 2× 409), not a 500; exactly
  one primary remains (partial unique index holds).
- **A-WRK-01 → P3 (REFUTED as stated)** — duplicate manual sync in the
  same hour returns 409 `conflict` via the unique `externalId`; only one
  row exists (FAILED, not orphaned PENDING). The audit's mechanism missed
  the `@unique` constraint. Residual: the 409 should be a typed
  `already_queued` (A-API-06).

### 3.2 P2 — Medium (58)

Security (6): A-SEC-04 open self-registration via mounted better-auth
handler; A-SEC-05 rate-limit identity is a client-spoofable header when
not behind Vercel; A-SEC-06 one unpinned action in a privileged
`pull_request_target` workflow (labeler); A-SEC-07 no rate limiting on
47 of 52 API routes; A-SEC-08 2FA available but never enforced
(including SUPER_ADMIN); A-SEC-09 API keys never expire, have no scopes,
confer full org read.
API (5): A-API-02 error contract inconsistent — 19/52 routes bypass
`withApiErrors`, most errors carry no `requestId`; A-API-03 invalid
`status` filter on `GET /api/websites` returns 500, invalid `range`
silently coerced to 28d; A-API-04 `writeAudit` failure after a successful
mutation turns the mutation into a 500; A-API-05 no rate limiting on
47/52 routes (mirror of A-SEC-07); A-API-06 manual sync once-per-hour
per website per type, failure is a confusing generic 409.
Database (11): A-DB-03 (downgraded, see above); A-DB-04 website PATCH can
move/re-status a website with an open transfer; A-DB-05 invite-accept
shell-org check/delete outside the transaction; A-DB-06 org delete
revokes Google tokens _before_ the delete transaction; A-DB-07
`WebsiteIntegration` has no DB rule tying the property FK to its
provider; A-DB-08 legacy polymorphic owner columns can drift from typed
owner FKs; A-DB-09 audit writes happen outside the mutation transaction;
A-DB-10 retention pruning is unbounded and never prunes stuck jobs;
A-DB-11 N+1 query patterns in portfolio and insights loaders; A-DB-12
legacy integrations with `googleConnectionId = NULL` can be fetched
under the wrong connection's credentials; A-DB-18 seed creates a
known-credential SUPER_ADMIN (POTENTIAL, unverified against prod).
Google (12): A-GGL-04 `SCOPE_MISSING` treated as retryable by the sync
engine; A-GGL-05 portfolio AdSense RPM invents `0` when earnings are
missing; A-GGL-06 disconnect leaves `MAPPED` integrations pointing at a
dead connection; A-GGL-07 Search Console date ranges never clamped for
the 2–3 day data delay; A-GGL-08 AdSense date parsing slices strings
without validation; A-GGL-09 AdSense report has no row-count/truncation
detection; A-GGL-10 web discover omits Ad Manager networks, upserts
sequentially, no stale-property pruning; A-GGL-11 health check aborts on
the first provider whose connection is missing; A-GGL-12 `cache-refresh`
sync aborts on the first provider that throws; A-GGL-13
`discoverConnectionProperties` has no per-provider isolation and no
stale pruning; A-GGL-14 a corrupt cached access token bricks the
connection instead of falling back to refresh; A-GGL-15 analytics
handler returns a raw 502 for authorisation failures instead of the
classified envelope.
Workers (9): A-WRK-04 scheduler lock TTL (55s) shorter than an unbounded
tick — a slow tick lets a second instance double-schedule; A-WRK-05
scheduler's last-success lookup is an unscoped full-table groupBy every
minute; A-WRK-06 weekly report has a 1-hour send window and no catch-up
— a missed hour loses a whole week; A-WRK-07 `cache-refresh` and
`ga4-historical` have no per-provider/per-report isolation; A-WRK-08
`healthCheckWebsite` early-returns on the first provider failure;
A-WRK-09 scheduler syncs websites of any status, including ARCHIVED /
SOLD / TRANSFER_PENDING; A-WRK-10 weekly report (and portfolio totals)
silently truncate at 200 websites; A-WRK-11 no crash handlers, no
shutdown timeout, in-flight tick not awaited; A-WRK-12 scale-benchmark
DB timings never run, and the script does not measure the production
queries.
Frontend (4): A-FE-03 integrations page loads everything unbounded
(connections × properties × websites); A-FE-04 dark-mode text contrast
fails 4.5:1 for links, muted, error/success/warning text; A-FE-05 login
collapses every failure into "Invalid email or password"; A-FE-07
"Sync now" reports "Queued." even when nothing will run and shows no
progress.
Live (3): A-LIVE-02 `/og.png` and `/favicon.ico` return 404 in
production; A-LIVE-03 no error monitoring/alerting configured for
production; A-LIVE-04 worker not deployed — scheduled production
behavior is absent.
Performance (2): A-PERF-01 no load, latency, or Core Web Vitals evidence
exists; A-PERF-02 scale benchmark (100/1k/10k sites) never executed
against a real DB.
Coverage (6): A-COV-05 worker (692 LOC) has zero tests; A-COV-06 token
refresh / OAuth flow / Google client untested in unit; A-COV-07 Redis
cache read/write/invalidate + env parsing untested; A-COV-08 6 of 8 Zod
validation schemas untested; A-COV-09 ESLint does not lint any
`.ts`/`.tsx` file; A-COV-10 barrel mocks can hide real wiring
regressions.
Baseline (1): A-BASE-02 coverage gate measures a fraction of the
codebase (overlap of A-COV-01).

### 3.3 P3 — Low (70)

Security (11): A-SEC-10 app pages leak the org member directory to any
authenticated user; A-SEC-11 `GET /api/teams` enumerates every org team
to any TEAM_ADMIN regardless of membership; A-SEC-12 `docker-compose.yml`
ships default credentials and publishes DB/Redis ports; A-SEC-13
`X-Powered-By: Next.js` still sent; COOP/CORP headers absent; A-SEC-14
token-encryption key and SMTP are optional at boot, failure surfaces
late; A-SEC-15 no session inventory/revocation UI, sign-in does not
revoke other sessions; A-SEC-16 audit `ipAddress` stores raw
attacker-controlled `x-forwarded-for`; A-SEC-17 transfer initiation
does not check source-website manage access; A-SEC-18 last-admin guards
are check-then-act, not atomic; A-SEC-19 org DELETE destroys the audit
trail it should preserve; A-SEC-20 invite-accept deletes the old org
best-effort and ignores failure.
API (12): A-API-07 `PUT /api/reports/schedule` silently drops invalid
recipient emails; A-API-08 `PATCH /api/teams/[id]` writes no audit
record; A-API-09 pagination inconsistent, `loadInsights` silently
truncates past 50 websites; A-API-10 disabled Ad Manager returns HTTP
200 with an error payload; A-API-11 success/error response shapes vary
route to route; A-API-12 `website.transfer` is SUPER_ADMIN-only in
practice, `audit.view` has no API route; A-API-13 property discovery is
unbounded, unthrottled, sequential-per-account; A-API-14
`snapshotUpdatedAt` reports first-write time, not last-write time;
A-API-15 organization export is unbounded and unthrottled; A-API-16
`GET /api/v1/websites` silently truncates at 500 with no paging or flag;
A-API-17 transfer state transitions are check-then-act, not guarded
updates; A-API-18 `POST /api/sync` and `POST /api/google/properties/discover`
return 503/200 shapes that hide the real state.
Database (5): A-DB-13 expired invites, verification rows, and
NULL-website health rows are never pruned; A-DB-14 dead `TransferStatus`
values `INITIATED` and `TRANSFERRED` still live in the enum and the
open-transfer index; A-DB-15 no `migration_lock.toml` in
`packages/db/prisma/migrations/`; A-DB-16 sequential per-property
upserts in the discover route, scheduler loads all websites into memory;
A-DB-17 range rules enforced only at the route, not the DB; unnecessary
index on `TwoFactor.secret`.
Google (7): A-GGL-16 GA4 realtime fails entirely if any one breakdown
query fails; A-GGL-17 OAuth callback swallows all errors silently, an
empty granted-scope list creates an ACTIVE scope-less connection;
A-GGL-18 `getGoogleAccountProfile` falls back to a fake email that can
collide two accounts; A-GGL-19 worker sync rate limit degrades fail-open
on Redis errors; A-GGL-20 over-scoped connect + Ad Manager network
pagination silently drops repeats; A-GGL-21 refresh-lock unit test is
timing-flaky (60ms deadline vs 5ms poll); A-GGL-22 custom date ranges
accept impossible dates.
Workers (9): A-WRK-01 (downgraded, see §3.1); A-WRK-13 backoff off-by-one
(first retry 60–120s, 1h cap unreachable with 5 attempts); A-WRK-14
rate-limit path writes a misleading RETRYING row and bypasses
backoff/counters; A-WRK-15 property discovery aborts entirely if one
provider's list call throws; A-WRK-16 failure alerts have no
aggregation — a provider outage emails per website per queue; A-WRK-17
scheduler silently drops enqueues when Redis is unavailable; A-WRK-18
DLQ rows are pruned after 30 days with no notice; A-WRK-19 health
endpoint has no listen-error handler and `/metrics` is unauthenticated;
A-WRK-20 no `stalled`/`lockRenewalFailed` observability, `websiteId!`
assertion in the processor.
Frontend (14): A-FE-06 wide tables have no horizontal-scroll container
(mobile overflow risk); A-FE-08 2FA setup shows the secret as text only,
no QR code; A-FE-09 edit-website status select omits two valid statuses;
A-FE-10 session revoke ignores the API response, so a failed revoke
looks successful; A-FE-11 DateRangePicker does not expose the active
range to assistive tech; A-FE-12 theme toggle is not persisted and has
no accessible state; A-FE-13 reset-password form has no confirm-password
field; A-FE-14 transfers page: dead INITIATED branch + stale "via POST
API" hint; A-FE-15 audit (100), transfers (50) and members/teams lists
are uncapped or unpaginated; A-FE-16 top-pages chart has no text
alternative, realtime values can render blank; A-FE-17 forgot-password
always shows success, even on network/server failure; A-FE-18 new
API-key secret has no copy button; A-FE-19 mobile nav drawer does not
trap focus; A-FE-20 sign-out proceeds to /login even if the logout
request fails.
Live (1): A-LIVE-05 live Google data verification is partial (Search
Console verified live 2026-11-21; GA4/AdSense unverified).
Performance (3): A-PERF-03 all 75 routes are dynamic, no caching headers
for pages; A-PERF-04 unit suite is import-bound and slow off CI
(159–190s); A-PERF-05 no DB query-plan evidence for the hot paths.
Coverage (6): A-COV-11 weak-assertion inventory; A-COV-12 flakiness and
suite-speed risks; A-COV-13 UI and e2e journey coverage is thin;
A-COV-14 DB write paths untested in unit; A-COV-15 no per-file
thresholds, aggregate hides a 50% file; A-COV-16 auth email sending
paths untested.
Baseline (2): A-BASE-01 unit suite fails locally on the default hook
timeout (flake); A-BASE-03 `turbo run build` warns `@metricflock/db#build`
has no outputs.

## 4. What is verified sound (not just claimed)

- Token crypto: AES-256-GCM envelope + AAD + rotation.
- OAuth: HMAC single-use state + PKCE S256; scopes verified.
- Passwords: scrypt; min length 12; verification-gated sign-in.
- Refresh-lock fencing; org-scoped cache/snapshot keys.
- No raw SQL; no `dangerouslySetInnerHTML`; no SSRF; no open redirects.
- CSV neutralization; audit scrubbing; nonce CSP; SHA-pinned workflows
  (one exception: labeler).
- Migration↔schema equivalence: 25/25 tables, 9/9 enums, 42 FKs.
- GA4/SC/AdSense aggregation math recomputed from code and correct
  except the AdSense RPM `?? 0` bug (A-GGL-05).
- CI #207 green: 196/196 unit, smoke ALL CHECKS PASSED, e2e 24/24.
- Live: `/api/health` 200; login renders; headers Grade A+; Vercel
  READY on HEAD.

## 5. Gaps — what was NOT tested / is still blocked

- **Dynamic auth/IDOR exploitation beyond the executed P1s:** the top
  P1s were executed live; a full exploitation sweep was not. A P0
  cannot be excluded for unexecuted areas.
- **Anything needing Redis/worker:** queue execution, scheduler ticks,
  report re-mail loop (A-WRK-03), refresh-lock contention, the
  with-Redis half of A-WRK-01 — NOT RUN (no Redis in sandbox; production
  Redis is down).
- **Live Google APIs:** GA4, AdSense, Ad Manager networks NOT RUN (no
  live account). Search Console's 2026-11-21 live verification is
  history only.
- **Load / latency / Core Web Vitals / DB query plans / scale benchmark
  (100/1k/10k sites):** NOT RUN — no staging env; production must not
  be load-tested.
- **Authenticated production workflows:** BLOCKED — no authorized test
  account; real customer data must not be touched.
- **Playwright e2e against the real DB:** BLOCKED — needs the seeded
  demo admin; `demo@example.com` does not exist in this DB and must not
  be created there.
- **Backup/recovery:** provider PITR assumed; CI restore drill exists
  per repo docs — not re-verified live.

## 6. Final decision and next steps

**Decision: 2 — NOT READY — HIGH-PRIORITY ISSUES REMAIN.** 18 P1s,
five confirmed by execution, plus an undeployed worker, a persistently
failing readiness probe (Redis down), and unverified live Google data.
The live deployment should be treated as controlled/staging-grade: do
not expand production usage, do not onboard additional tenants, and do
not claim production readiness until P1 remediation is verified by a
re-audit of the affected areas.

Next steps (from `11-REMEDIATION-PLAN.md`, Stage 1 = 16 P1 items):
scope the DLQ/metrics queries by org; make transfer transitions atomic
(guarded updates); add step-up/fresh-session checks on destructive and
privilege-minting routes; guard the seed behind a strict production
check; rewrite Ad Manager reporting (create → run → poll → fetchRows)
or remove it; fail-closed token refresh without Redis; add timeouts to
all googleapis calls; per-recipient fault isolation in the report loop;
duplicate-submit guards on all forms; paginate the websites list;
fix the coverage gate scope and add tenant.ts / transfer / route tests;
restore Redis (or remove `REDIS_URL`) and fix the readiness probe.
Then: deploy the worker, then P2s, then P3s. Re-audit gates (7) in
`11-REMEDIATION-PLAN.md` define when the decision can move.
