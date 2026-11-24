# 00 — Repository and Environment Baseline

Audit date: 2026-11-23. Auditor: independent audit (coordinator pass).
Repo: https://github.com/zuhandeveloper/metricflock — branch `main`.

## 0.1 Repository state (verified)

| Item                | Value                                                                            | How verified                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD SHA (main)     | `6e6d2b21ef0acf359d845f58c5a92d6c0d5d5391`                                       | GitHub connector `list_commits` (main, perPage 1), 2026-11-23                                                                                                                                                                                                                                                                                        |
| Local tree          | `~/workspace/metricflock/`                                                       | Plain file copy — **no `.git` directory exists in the sandbox**, so local `git status` / branch / diff-vs-origin checks are NOT POSSIBLE here. HEAD was verified via the GitHub connector instead. No local uncommitted-change check could be performed; no files were modified by this audit except the new `docs/audit/0*.md`–`11-*.md` documents. |
| HEAD commit message | "fix: run pnpm.exe directly on Windows (npm_execpath is a binary, not a script)" | GitHub Actions runs list, 2026-11-23                                                                                                                                                                                                                                                                                                                 |
| CI on HEAD          | CI #207 SUCCESS (5m 24s)                                                         | Prior verified report + Actions runs list showing CI #207 for 6e6d2b2. Unit 38 files / 196 tests, smoke ALL CHECKS PASSED, e2e 24/24 (per CI #207 report). The text fetch of the Actions list does not expose run status badges, so the SUCCESS verdict rests on the earlier verified CI #207 report, not on this fetch.                             |

## 0.2 Inventory (counted from source, 2026-11-23)

| Item                                                                   | Count                                                                                                                                                    | Method                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Source files (`.ts`/`.tsx`, apps + packages, excl. node_modules/.next) | 215                                                                                                                                                      | `find`                                 |
| API route files (`route.ts` under `apps/web/src/app/api`)              | 52                                                                                                                                                       | `find` (full list in §0.3)             |
| Prisma models                                                          | 25                                                                                                                                                       | `grep '^model '` on schema.prisma      |
| Prisma enums                                                           | 9                                                                                                                                                        | `grep '^enum '`                        |
| Migrations                                                             | 13                                                                                                                                                       | `ls packages/db/prisma/migrations/`    |
| App pages (`page.tsx`)                                                 | 20                                                                                                                                                       | `find apps/web/src/app -name page.tsx` |
| Unit test files                                                        | 38                                                                                                                                                       | `find -name '*.test.ts'`               |
| E2E spec files                                                         | 3 (`accessibility`, `app-accessibility`, `journeys`) + `auth.setup.ts`                                                                                   | `ls apps/web/tests/e2e`                |
| TODO / FIXME / XXX / HACK markers in source                            | 0                                                                                                                                                        | `grep -rn` over apps + packages        |
| Workspaces                                                             | apps/web, apps/worker; packages db, auth, google, jobs, shared                                                                                           | package.json workspaces                |
| External integrations                                                  | Google OAuth + GA4 + Search Console + AdSense + Ad Manager (via `packages/google`), SMTP mailer, Redis (BullMQ/cache), Postgres (Prisma), Vercel hosting | code inspection                        |
| Background jobs                                                        | BullMQ queues: sync (per-provider), scheduled-report; scheduler tick plans realtime/historical/SC/AdSense/health/report jobs                             | `packages/jobs`, `apps/worker`         |
| Scheduled jobs                                                         | Worker scheduler (realtime 300s, historical 45m, SC 8h, AdSense 3h, health 1h, weekly reports)                                                           | `apps/worker/src/scheduler.ts`         |

### Migrations (13)

`20261118000000_init`, `20261119000000_better_auth`,
`20261120000000_stage2_db_integrity`, `20261120010000_stage3_oauth_state`,
`20261120020000_stage5_job_bookkeeping`, `20261120030000_stage7_account_security_audit`,
`20261120040000_stage7_transfer_enum`, `20261120040001_stage7_transfer_state_machine`,
`20261121000000_organization_invites`, `20261121010000_website_status_backfill`,
`20261122000000_phase4_db_integrity`, `20261123000000_report_schedules`,
`20261123010000_api_keys`.

Production DB confirmed in sync by the owner on 2026-11-23
(`pnpm db:status`: "13 migrations found, Database schema is up to date!").

### API routes (52)

Analytics (9): overview, traffic, audience, pages, events, realtime,
search-console, adsense, ad-manager. Auth (3 + better-auth catch-all):
login, logout, `[...all]`. Google (6): connections, connections/disconnect,
oauth/connect, oauth/callback, properties/discover, properties/map.
Websites (5): list/create, `[id]` (GET/PATCH/DELETE), `[id]/assign`,
`[id]/transfer`. Teams (3): list/create, `[id]`, `[id]/members`. Members (3):
`[id]`, invite, invite/`[id]`. Transfers (4): accept, cancel, complete,
reject. Sync (3): list/create, failed, requeue. Reports (2): schedule,
send-test. Organization (2): GET/DELETE, export. Insights (1),
integrations/health (1), invites/accept (1), health (1), health/ready (1),
metrics (1), api-keys (2: list/create, `[id]` revoke). Public API v1 (5):
websites, websites/`[id]`/analytics, portfolio, health, insights.

## 0.3 Baseline commands (all run locally in the sandbox, 2026-11-23)

Environment: Node 26.13.1 (`~/workspace/.tools/node-v26.13.1-linux-x64/bin`),
pnpm 12.21.0 (`~/.local/share/pnpm/bin`), dummy
`DATABASE_URL="postgresql://user:pass@127.0.0.1:1/db?sslmode=disable"`,
`SESSION_SECRET="sandbox-test-secret-at-least-32-characters"`, cached Prisma
engines (`~/.cache/prisma/c2990dca591cba766e3b7ef5d9e8a84796e47ab7/debian-openssl-3.0.x/`),
`turbo run … --env-mode=loose`. No Postgres/Redis/Docker/psql in the sandbox.

| Command                                                                                  | Exit    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                      | 0       | All matched files Prettier-clean                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm lint` (ESLint + `scripts/check-boundaries.sh`)                                     | 0       | boundary checks passed                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm audit --prod`                                                                      | 0       | No known vulnerabilities found                                                                                                                                                                                                                                                                                                                                                                                                            |
| `turbo run typecheck --env-mode=loose`                                                   | 0       | 8/8 tasks successful                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `turbo run build --env-mode=loose`                                                       | 0       | 2/2 tasks successful                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `turbo run test --env-mode=loose` (via `turbo run typecheck test build`)                 | **1**   | **1 failure: `apps/web/tests/unit/rate-limit-failclosed.test.ts` — `HookTimeoutError: Hook timed out in 10000ms` in `beforeAll` (line 23). 37/38 files passed, 194 tests passed, 2 skipped (196). Full-suite duration 189.79s (import 87%).** See A-COV-08 / A-BASE-01.                                                                                                                                                                   |
| `vitest run tests/unit/rate-limit-failclosed.test.ts --hookTimeout=60000` (reproduction) | 0       | **2/2 passed in 7.41s in isolation.** The full-suite failure is a slow-environment hook timeout, not a product defect: the `beforeAll` does `vi.resetModules()` + a dynamic re-import of the `@metricflock/shared` barrel, which exceeds the default 10s hook timeout on the throttled sandbox (1.5 shared CPUs; the suite's total import time was 312.88s across 217 module evaluations). The same test passes in CI (CI #207: 196/196). |
| `vitest run --coverage --hookTimeout=60000` (apps/web)                                   | 0       | **38 files, 196/196 tests passed. Coverage: 99.23% stmts / 92.98% branches / 96.87% functions / 100% lines.** BUT the coverage scope is narrow — see A-COV-01: no `coverage.all`/`include` in `vitest.config.ts`, so v8 reports only files imported by the unit tests (8 files under `apps/web/src/lib/` per `coverage-final.json`); routes, packages, worker unmeasured.                                                                 |
| Smoke (`scripts/smoke-test.sh`)                                                          | NOT RUN | Needs real Postgres + Redis; runs in CI only. Read as evidence (615 lines, 36 checkpoints).                                                                                                                                                                                                                                                                                                                                               |
| Playwright e2e (`pnpm test:e2e`)                                                         | NOT RUN | Needs real DB + production build server; runs in CI only (24 tests, CI #207: 24/24).                                                                                                                                                                                                                                                                                                                                                      |

## 0.4 Baseline findings

### A-BASE-01 (P3) — Unit suite fails locally on the default hook timeout; flaky on slow machines

- **File:** `apps/web/tests/unit/rate-limit-failclosed.test.ts:23` (`beforeAll`, `vi.resetModules()` + dynamic `import("@metricflock/shared")`); `apps/web/vitest.config.ts` (no `hookTimeout` configured).
- **Evidence:** `turbo run test` exit 1; `HookTimeoutError: Hook timed out in 10000ms` (log `/tmp/audit-turbo.log` lines 116–131). Same file passes in isolation in 7.41s and in CI. Full-suite import time 312.88s (217 evaluations) on the 1.5-CPU sandbox vs ~9s unit step in CI.
- **Impact:** Developers on slow machines / constrained CI runners get a red suite for an environment reason; masks real failures and trains people to ignore test failures.
- **Correction:** set an explicit `hookTimeout` (e.g. 30s) in `vitest.config.ts`, or avoid `resetModules` + barrel re-import in this test (import the rate-limit module path directly). Regression test: none needed — the test itself is the regression test; verify the suite passes twice in a row locally.
- **Status:** CONFIRMED (environment-dependent flake, not a product defect).

### A-BASE-02 (P2) — Coverage gate measures a fraction of the codebase (see A-COV-01)

Recorded here as a baseline-scope caveat: the 99.23% headline covers only
files imported by unit tests. Details and severity in `09-TEST-COVERAGE-AND-QUALITY.md`.

### A-BASE-03 (P3) — `turbo run build` warns `@metricflock/db#build` has no outputs

- **Evidence:** `turbo run typecheck test build` output: "WARNING no output files found for task @metricflock/db#build. Please check your `outputs` key in `turbo.json`".
- **Impact:** cosmetic; `db#build` is `prisma generate` (writes into `node_modules/.prisma`), so the warning is expected but noisy; it can hide real cache misses.
- **Correction:** declare the generated-client path in `turbo.json` outputs for the db build task (or silence by design with a comment).
- **Status:** CONFIRMED (cosmetic).

## 0.5 Untested / dead-code notes

- No TODO/FIXME/XXX/HACK markers in source (grep, 2026-11-23).
- Dead-code and duplication analysis is delegated to the phase docs
  (esp. 02, 05, 06, 09); nothing was deleted during this audit.
- `apps/web/coverage/` artifacts are generated locally and gitignored;
  numbers above are from the live run output, not from stale artifacts.

## 0.6 What this baseline does NOT establish

- Live DB behavior (no Postgres in sandbox): migration application,
  constraint enforcement, and query plans are NOT RUN locally; they are
  covered by CI smoke (migrate deploy + seed + HTTP assertions) and by
  the Phase 3 static migration review. **Update 2026-11-23 (dynamic
  verification retry):** after the user enabled direct database
  protocols, a real Postgres connection WAS established from the
  sandbox (13/13 migrations confirmed applied) and the top DB
  findings were reproduced live — see §0.7 and §10.7. Query plans
  and the scale benchmark remain NOT RUN.
- Live Redis/worker behavior: NOT RUN locally (see Phase 5).
- Live Google APIs: NOT RUN locally (see Phase 4).
- Authenticated browser behavior: NOT RUN locally (see Phases 6–7).

## 0.7 Dynamic verification 2026-11-23 — first attempt BLOCKED, retry EXECUTED

After this audit the user supplied the development database URL
and asked for the NOT RUN items to be executed against the real
database. The first attempt stopped at step 1: the sandbox egress
proxy intercepted direct database connections (banner: `muse:
Database connections is turned off for this assistant. To allow it,
ask the user to open Muse settings -> Permissions -> Direct network
protocols and switch databases from Deny to Ask.`). `prisma migrate
status` and raw `pg` connections failed for the same reason, so no
dynamic reproduction was executed and no data (real or scratch) was
touched. The unit suite was re-run without a database and passes:
38 files / 196 tests, coverage 99.23 / 92.98 / 96.87 / 100.

**Retry (same day, after the user enabled direct database protocols,
Deny → Ask): EXECUTED — see §10.7 in
`10-FINAL-PRODUCTION-READINESS.md` for the full record.** Raw `pg`
connected (PostgreSQL 17.2); all **13 migrations APPLIED**; a local
app server was booted against the real database and the top P1s were
reproduced with scratch orgs only (all scratch data deleted, DB
verified back to its pre-test state). Confirmed by execution:
A-SEC-01, A-SEC-02, A-DB-01, A-DB-02, A-LIVE-01; partially
confirmed: A-GGL-01 (parser half); refuted/downgraded: A-DB-03
(P1 → P2), A-WRK-01 (P1 → P3). Still blocked: anything needing
Redis/worker, live Google APIs, load tests, authenticated production
workflows, Playwright e2e (no seeded demo admin in this database).
