# Phase 9 — Test Coverage and Regression Quality

- **Repo:** `~/workspace/metricflock/` (Next.js 16 monorepo, Vitest + Playwright)
- **Audit date:** 2026-11-23
- **Auditor:** independent coverage audit (subagent, depth 2)
- **HEAD claimed by brief:** `6e6d2b21` — **not verifiable in this sandbox: the sandbox
  copy has no `.git` directory**, so no commit, branch, or diff could be checked.
  All findings below are grounded in the source files as present on disk, not in
  any earlier audit doc. Earlier audit docs in `docs/audit/` were not used as
  evidence.
- **Scope:** all unit tests, all e2e specs, `scripts/smoke-test.sh`, CI workflow,
  vitest coverage config, and the source modules they claim to cover.

## 0. What was actually run (commands, exit codes, outputs)

All commands were run with the sandbox env from the brief
(Node 26.13.1, pnpm 12, dummy `DATABASE_URL`, `SESSION_SECRET`,
Prisma engine vars). No Postgres, Redis, or Docker exists in the sandbox.

| Command                                                                  | Result                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd apps/web && pnpm run test:coverage` (`vitest run --coverage`)        | **EXIT 0. 38 test files passed, 196 tests passed, 0 failed.** Duration 232.7s (import 91% of tracked time). Full log: `/tmp/cov.log` (ephemeral; numbers below are transcribed from it). |
| `find apps packages -name '*.test.ts'` + e2e/smoke inventory             | 38 unit files, 3 e2e spec files + setup, 615-line smoke script. See §1.                                                                                                                  |
| `grep` / import-graph analysis of every test file vs every source export | See §3–§5. No test file was taken at face value; assertions were read.                                                                                                                   |
| `pnpm test:coverage` at repo root / `turbo run test`                     | **NOT RUN** (would rebuild + rerun the same web suite; the per-package picture is established from `package.json` scripts — only `@metricflock/web` defines `test`/`test:coverage`).     |
| `bash scripts/smoke-test.sh`                                             | **NOT RUN** — needs real Postgres + Redis + `next start`. Read as evidence only (§4).                                                                                                    |
| `pnpm --filter @metricflock/web test:e2e` (Playwright)                   | **NOT RUN** — needs a built app + seeded Postgres. Read as evidence only (§4).                                                                                                           |
| Full CI (`.github/workflows/ci.yml`)                                     | **NOT RUN** — no GitHub access from this audit; CI history (e.g. run numbers) was not verified.                                                                                          |

### Measured coverage (local run, 2026-11-23)

```
Test Files  38 passed (38)
     Tests  196 passed (196)
All files          |   99.23 |    92.98 |   96.87 |     100 |
```

Per-file (v8 provider; **only 8 files appear in the report at all**):

| File (`apps/web/src/lib/`) | % Stmts | % Branch | % Funcs | % Lines | Uncovered                |
| -------------------------- | ------- | -------- | ------- | ------- | ------------------------ |
| analytics-response.ts      | 100     | 100      | 100     | 100     | —                        |
| api-error.ts               | 95.83   | 83.33    | 100     | 100     | stmts 24, 72–77          |
| api-key-auth.ts            | 100     | 100      | **50**  | 100     | 1 of 2 counted functions |
| csv.ts                     | 100     | 100      | 100     | 100     | —                        |
| health.ts                  | 100     | 81.81    | 100     | 100     | stmts 74–75              |
| insights.ts                | 100     | 90.32    | 100     | 100     | stmts 98, 118–119        |
| pagination.ts              | 100     | 100      | 100     | 100     | —                        |
| portfolio.ts               | 100     | 100      | 100     | 100     | —                        |

Gate in `apps/web/vitest.config.ts:29`: `thresholds: { statements: 90, branches: 80,
functions: 90, lines: 90 }` — **passed** locally. The config comment says the
thresholds were "set just below measured values (2026-11-21: 97.7% stmts / 91.7%
branch / 100% funcs / 100% lines)". The numbers moved since (99.23 / 92.98 /
96.87 / 100) but the gate still passes — see A-COV-01 for why that pass is
nearly meaningless.

## 1. Test inventory (counted, not claimed)

### 1.1 Unit tests — 38 files, 196 tests

Per-file test counts (from the vitest run output):

| File                 | Tests | File                  | Tests   |
| -------------------- | ----- | --------------------- | ------- |
| ad-manager-parse     | 10    | oauth-scopes          | 9       |
| adsense-parse        | 3     | oauth-state           | 6       |
| analytics-response   | 3     | pagination            | 2       |
| api-error            | 3     | permissions           | 6       |
| api-key-auth         | 4     | portfolio             | 9       |
| api-keys             | 3     | rate-limit            | 3       |
| audit-retention      | 3     | rate-limit-failclosed | 2       |
| audit-scrub          | 3     | redact                | 6       |
| auth-config          | 8     | refresh-lock          | 4       |
| cache-keys           | 3     | report                | 4       |
| client-ip            | 4     | scheduler-plan        | 7       |
| crypto               | 13    | search-console-parse  | 4       |
| csv                  | 3     | snapshot-ttl          | 3       |
| discovery-pagination | 6     | sync-engine           | 14      |
| ga4-parse            | 7     | tenant-isolation      | 3       |
| health               | 8     | transfer              | 3       |
| insights             | 6     | validation            | 4       |
| insights-loader      | 3     | **Total**             | **196** |
| job-backoff          | 5     |                       |         |
| logger-metrics       | 4     |                       |         |
| mailer               | 5     |                       |         |

Notes: no `.skip`, `.todo`, or `.only` anywhere in `apps/web/tests/`. No
`vi.useFakeTimers` anywhere. No component tests: vitest `include` is only
`tests/unit/**/*.test.ts`, environment is `node`, and there is no
`@testing-library` dependency — all 20 pages and ~15 client components
(`WebsiteForms.tsx`, `TransferActions.tsx`, `ApiKeyManager.tsx`, etc.) have
zero unit/component coverage.

### 1.2 E2E (Playwright) — 24 tests including setup, none run here

- `tests/e2e/accessibility.spec.ts` — 5 tests: axe (critical/serious only) on
  `/login`, `/forgot-password`; security-header assertions; CSP-violation
  console watch; signed-out `/dashboard` → `/login` redirect.
- `tests/e2e/app-accessibility.spec.ts` — 13 tests: axe on 12 signed-in pages
  (`/dashboard`, `/websites`, `/teams`, `/members`, `/integrations`, `/health`,
  `/insights`, `/transfers`, `/audit`, `/settings/security`,
  `/settings/reports`, `/settings/api-keys`) + skip-link focus test.
- `tests/e2e/journeys.spec.ts` — 5 tests: create team, create website, create +
  revoke API key, save weekly report schedule, mobile nav open/navigate/close.
- `tests/e2e/auth.setup.ts` — 1 setup test signing in as seeded demo admin
  (`demo@example.com`); `retries: 1` in CI (`playwright.config.ts`).
- The e2e suite boots `next start` itself (`webServer`, port 3200) and needs a
  migrated + seeded database. It exercises UI flows only; no e2e test calls an
  API route directly.

### 1.3 Smoke test — `scripts/smoke-test.sh`, 615 lines, 36 `ok "..."` checkpoints

Verified by reading the whole script. Sections (in order): migrate + seed,
admin sign-in, analytics `not_connected`, queue one sync job, member transfer
403 / admin transfer 200, Stage-1 security (mass assignment, unverified
sign-in, role escalation, cross-org teamId, foreign OAuth owner), legitimate
create, Stage-2 mapping rules (undiscovered property, single primary,
server-managed status, last-admin guard, connection visibility), Stage-3 OAuth
state (forged/expired/wrong-session/replay), Stage-5 pagination bound,
Stage-6 headers + login labels, Stage-7 password reset + TOTP + two-sided
transfer lifecycle + security page/audit, Stage-8 health/metrics/correlation
ids/DLQ requeue + backup/restore drill (`pg_dump` → scratch DB), Stage-9
cross-tenant IDOR matrix (9 probes expecting 404 + list scoping), UI forms
render, invite flow, team delete (empty 200 / with-websites 409 / foreign
404), PENDING_SETUP → ACTIVE flip, website delete, Phase-1 manage-level
tenant isolation (F-1.1/F-1.2/F-1.3), Phase-4 data lifecycle (member delete
guards, org export leak checks, org delete slug gate). **None of this ran in
this audit** (no Postgres/Redis); its CI status is unverified here.

### 1.4 CI — `.github/workflows/ci.yml` (read, not run)

One job, `ubuntu-latest`, with Postgres 16 + Redis 7 service containers. Steps
in order: gitleaks → pnpm setup → Node 26 → `pnpm install --frozen-lockfile` →
`pnpm audit --prod` → `pnpm format:check` → `pnpm typecheck` → `pnpm lint` →
`pnpm test:coverage` → `pnpm build` → `bash scripts/smoke-test.sh` →
Playwright Chromium install → `pnpm --filter @metricflock/web test:e2e`.
Triggers: push/PR to `main` only. No scheduled run, no separate job per package,
no coverage upload, no test-result artifact upload, no failure notification
step. `turbo.json` makes `test`/`test:coverage` depend on `^build`, but no
package other than `@metricflock/web` defines a `test` or `test:coverage`
script, so `turbo run test` executes exactly one package's suite.

## 2. Coverage scope — the headline number measures 8 files

The v8 coverage report contains **only the 8 files under
`apps/web/src/lib/`** that the unit tests import directly
(`coverage/coverage-final.json` listed exactly 8 files in the local run).
There is no `coverage.include` / `coverage.all` in `vitest.config.ts`, so
nothing outside the vitest root (`apps/web`) is instrumented — **no file in
`packages/auth`, `packages/shared`, `packages/google`, `packages/jobs`,
`packages/db`, `apps/worker`, and no API route file appears in coverage at
all**, even though the tests import and execute those modules (e.g.
`@metricflock/shared`, `@metricflock/google/sync`,
`@metricflock/auth`). The 99.23% / 92.98% / 96.87% / 100% headline therefore
describes 8 lib files, not the repo. This is A-COV-01.

## 3. Module-by-module quality judgement

Method: for every exported function/constant in `packages/*/src`,
`apps/web/src/lib`, and `apps/worker/src`, I checked whether its name appears
in any unit test (a name appearing is necessary, not sufficient, for coverage)
and read the tests that do mention it. "Covered by smoke" means the behaviour
is exercised only over HTTP in `scripts/smoke-test.sh` (CI-only, NOT RUN here).

### 3.1 `packages/auth` — tenant isolation is smoke-only

- `tenant.ts` (150 lines, 9 exports): `assertTeamAccess:5`,
  `assertTeamManageAccess:20`, `assertConnectionScopeForWebsite:34`,
  `assertWebsiteAccess:52`, `assertWebsiteManageAccess:72`,
  `assertConnectionOwnerAccess:85`, `connectionVisibilityWhere:93`,
  `assertConnectionVisible:108`, `listAccessibleWebsiteIds:125` — **none of
  the 8 assert/visibility functions is named in any unit test**.
  `tenant-isolation.test.ts` (3 tests) only checks `buildCacheKey` org-scoping
  and the pure `hasPermission` table. The real tenant enforcement is exercised
  only by smoke §Stage-9/Phase-1 over HTTP. A regression that inverts an
  assert (e.g. `assertWebsiteManageAccess` returning instead of throwing)
  would pass the entire unit suite.
- `server.ts:225,231,239` (`getSessionUser`, `requireAuth`, `destroySession`):
  no unit test. `api-helpers.ts:5` (`requireApiAuth`, the per-route permission
  gate used by most API routes): no unit test; `apiError:12` is covered only
  via `api-error.test.ts` indirectly. `permissions.ts` is well covered at the
  pure-function level (`permissions.test.ts`, 6 tests) but that only pins the
  role→permission table, not that any route calls `requireApiAuth` with the
  right permission.
- `auth-config.test.ts` (8 tests) asserts better-auth _configuration values_
  (`role.input === false`, `requireEmailVerification`, min password length 12,
  `databaseHooks.user.create.before` is a function). It never invokes the
  hooks, so a hook that silently returns without enforcing (e.g. an invite
  hook that doesn't set the org) passes. Behavioural proof is smoke-only.

### 3.2 `packages/shared` — pure logic strong, Redis/env paths untested

- Strong: `crypto.ts` (13 tests incl. AAD/re-encryption), `redact.ts`
  (6 tests), `rate-limit.ts` in-memory path (3 tests), `report.ts`,
  `insights.ts` (seo/revenue/channel), `portfolio-aggregate.ts`,
  `retention.ts`, `health-state.ts`, `logger.ts`/`metrics.ts`, `api-keys.ts`.
- Gaps: `cache.ts:70,88,108,117` (`cacheGet`, `cacheSet`,
  `invalidateWebsiteCache`, `invalidateOrgCache`) — only `buildCacheKey:50`
  is unit-tested (`cache-keys.test.ts`, 3 tests). The real Redis read/write/
  invalidate path is never unit-tested; `sync-engine.test.ts` injects a fake
  `cacheSet`. A wrong invalidation key would pass unit tests and only surface
  in production (stale analytics) — smoke does not assert cache invalidation
  either. `cache.ts:6,26` (`getRedis`, `bullConnectionOptions`): untested.
- `env.ts` (`getEnv`, `googleEnabled`): no unit test at all. A mis-parsed env
  flag (e.g. Ad Manager reported enabled when disabled) has no regression
  test; `ad-manager-parse.test.ts` sets `GOOGLE_AD_MANAGER_ENABLED=true`
  manually per test.
- `validation.ts`: only `websiteCreateSchema:13` and `mapPropertySchema:38`
  are unit-tested (`validation.test.ts`, 4 tests). Untested in unit:
  `dateRangeSchema:2`, `teamCreateSchema:29`, `transferSchema:37`,
  `analyticsQuerySchema:48`, `inviteCreateSchema:52`, `memberRoleSchema:58`.
  Some are exercised indirectly by smoke HTTP calls (which assert status
  codes, not validation error shapes).

### 3.3 `packages/google` — parsers strong, token/OAuth/client paths thin

- Strong: GA4/Search Console/AdSense/Ad Manager parsers (7+4+3+10 tests,
  incl. the F-3.4 total-CTR recomputation assertion), discovery pagination
  (6 tests: nextPageToken, per-account isolation, page cap 10, token-loop
  guard), OAuth scopes (9 tests), OAuth state HMAC (6 tests), sync engine
  orchestration (14 tests via injected `SyncDeps` — the best-designed tests
  in the repo: real engine code, fake deps, incl. quota → `SyncRateLimitError`
  and revoked-grant → `skipped`).
- Gaps: `tokens.ts:113` (`getValidAccessToken` — refresh, expiry, invalid-grant
  handling) is **never called directly**; it appears in tests only as an
  injected `vi.fn` inside `sync-engine.test.ts:82,204`. `tokens.ts:194`
  (`revokeConnection`): never tested anywhere in unit; smoke only disconnects
  a connection over HTTP and checks the status code, not token revocation at
  Google. `tokens.ts:58` (`withRefreshLock`, unexported) is covered only via
  `acquireRefreshLock` (`refresh-lock.test.ts`, 4 tests with a fake Redis).
- `oauth.ts`: `createOAuthFlow`, `consumeOAuthState`, `buildAuthUrl`,
  `getGoogleAccountProfile`, `getOAuthClient` — no unit tests; covered only by
  smoke Stage-3 (state forgery/expiry/replay over HTTP). `client.ts`
  (`resolveConnectionForWebsite`, `getAuthorizedClientForWebsite`,
  `getAuthorizedClientForIntegration` incl. the DATA-5 connection-scoping and
  F-2.1c scope checks): no unit tests; covered only by smoke mapping/IDOR
  probes. `search-console.ts` (`listSitemaps`, `inspectUrl`): untested.
  `sync.ts`: `healthCheckWebsite` untested in unit (only `syncWebsite` /
  `refreshConnection` / `discoverConnectionProperties`).

### 3.4 `packages/jobs` + `apps/worker` — the queue is untested, the worker is untested

- `queue.ts:71,107,125` (`getQueue`, `enqueue`, `enqueueBulk` — the actual
  BullMQ enqueue path, dedup jobIds, priorities): **no tests**. Only the pure
  `jitteredBackoffMs:67` is tested (`job-backoff.test.ts`, 5 tests). The
  `/api/sync` route's enqueue is exercised once in smoke (status code only);
  a silently dropped or duplicated job would pass.
- `scheduler.ts` (`packages/jobs`): pure helpers tested
  (`scheduler-plan.test.ts` 7 tests: `planDueSyncs`, `staggerDelayMs`,
  `SYNC_INTERVALS`, queue↔sync-type maps; `snapshot-ttl.test.ts` 3 tests).
  `intervalMsForQueue:40` and `queuesForProviders:72` are not named in tests.
- `apps/worker/src/` — **692 lines, 0 tests, no `test` script**:
  `index.ts` (351 lines: BullMQ workers, failure alerts to SUPER_ADMINs,
  job bookkeeping), `report.ts:29` (`sendOrgReport`), `scheduler.ts:196`
  (`startScheduler`). The worker is the component that actually calls Google
  and sends scheduled reports in production. Its only coverage is indirect:
  smoke queues one job via `/api/sync` but never runs a worker, so no
  end-to-end sync, report email, or failure-alert path is ever executed in
  any suite. (Worker hosting itself is a separate, still-open decision per
  repo history; that does not change the coverage fact.)

### 3.5 `packages/db` — write paths untested in unit

- `audit.ts:23` (`writeAudit`): no unit test (`audit-scrub.test.ts` covers
  only the pure `scrubAuditDetails:9`; `audit-retention.test.ts` covers only
  the pure `auditRetentionDays`). Smoke asserts audit rows exist for some
  flows (Stage-7 security page) but not per-operation audit completeness.
- `snapshots.ts:15,42,49` (`writeSnapshot`, `invalidateWebsiteSnapshots`,
  `invalidateOrgSnapshots`): no unit tests; `readSnapshot:31` is mocked in
  portfolio/insights tests, never really executed. `health.ts`
  (`lastSuccessfulSync`): untested. `seed.ts` and the 10 `scripts/smoke-*.ts`
  fixtures are exercised only by running smoke/seed themselves.

### 3.6 `apps/web/src/lib` — the only measured area, and still incomplete

- `analytics-handler.ts` (`classifyAnalyticsError`, `handleAnalyticsRequest`):
  **imported by no test** and absent from coverage (not in the 8 measured
  files). It is the shared handler behind all 9 analytics routes — see
  A-COV-04.
- `transfers.ts` (43 lines): `loadTransferInOrg:14`, `expireIfStale:22`
  (7-day TTL expiry), `canActForDestination:37` — **none named in any test**.
  See A-COV-03.
- `api-error.ts`: uncovered statements 24, 72–77 — the catch-all unhandled
  error path inside `withApiErrors` (log + `incr("api.internal_error")` +
  generic 500) is never executed by tests, even though every route depends
  on it. `requestIdOf` is not named in tests.
- `health.ts`: uncovered statements 74–75; `insights.ts`: 98, 118–119
  (partial-snapshot / unavailable branches) — the "honest about missing data"
  branches are only partly exercised despite being a stated product
  requirement.
- `api-key-auth.ts`: 100% statements/lines but **50% functions** — one of the
  two counted functions is never called (the file exports one function,
  `requireApiKey:19`; the second counted function is the module's internal
  closure — regardless, the aggregate 96.87% functions headline hides a
  per-file 50%). No per-file threshold exists to catch this (see A-COV-15).

### 3.7 API routes — 52 route files, 0 route-level unit tests

No test file imports any `route.ts`. Route behaviour is covered only by smoke
(CI-only) and, for 2 routes, by e2e UI flows. Route-by-route evidence
(smoke = `scripts/smoke-test.sh` string match; e2e = UI flow):

| Route group                                                                                                | Evidence                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api/analytics/overview`                                                                                   | Smoke: `not_connected` + foreign 404.                                                                                                                                                      |
| `api/analytics/traffic, audience, pages, events, realtime, search-console, adsense, ad-manager` (8 routes) | **No suite exercises them.** Only their parsers are unit-tested; the routes, their `handleAnalyticsRequest` wiring, snapshot-first fallback, and per-route permission checks are untested. |
| `api/v1/health, insights, portfolio, websites, websites/[id]/analytics` (5 routes)                         | **No suite exercises them.** `requireApiKey` is unit-tested in isolation (`api-key-auth.test.ts`, 4 tests incl. 429), but no v1 route handler is ever invoked.                             |
| `api/insights`                                                                                             | **No suite exercises it.**                                                                                                                                                                 |
| `api/integrations/health`                                                                                  | **No suite exercises it.**                                                                                                                                                                 |
| `api/reports/schedule`                                                                                     | E2E journey only (save weekly schedule via UI, asserts "schedule saved"). No API-level test; no negative test.                                                                             |
| `api/reports/send-test`                                                                                    | **No suite exercises it.**                                                                                                                                                                 |
| `api/api-keys`, `api/api-keys/[id]`                                                                        | E2E journey only (create + revoke via UI). No unit test of the route handlers; no test of list/get.                                                                                        |
| `api/auth/login`                                                                                           | Smoke (2FA flow). `api/auth/logout` — **no suite exercises it.** `api/auth/[...all]` — exercised via better-auth endpoints in smoke (sign-in/sign-up/reset/2FA).                           |
| `api/organization` (GET/DELETE)                                                                            | Smoke exercises DELETE (slug gate) and export; **GET has no clear smoke call** (the 3 `/api/organization` matches are export + 2 deletes) — POTENTIAL gap.                                 |
| `api/organization/export`                                                                                  | Smoke: 200 + leak checks (`encryptedRefreshToken`, `password` absent).                                                                                                                     |
| `api/invites/accept`                                                                                       | **No suite exercises it.** (Smoke tests invite _creation_ + invited sign-up, not the accept endpoint.)                                                                                     |
| `api/members/invite/[id]`                                                                                  | **No suite exercises it.**                                                                                                                                                                 |
| `api/members/[id]`                                                                                         | Smoke: DELETE + guards only. GET/PATCH (if any) untested.                                                                                                                                  |
| `api/transfers/[id]/accept, complete`                                                                      | Smoke (lifecycle + duplicate + non-admin accept 403).                                                                                                                                      |
| `api/transfers/[id]/cancel, reject`                                                                        | **No suite exercises them** (0 matches in smoke).                                                                                                                                          |
| `api/websites`, `[id]`, `[id]/assign`, `[id]/transfer`                                                     | Smoke: extensive (CRUD, IDOR matrix, Phase-1 manage checks).                                                                                                                               |
| `api/teams`, `[id]`, `[id]/members`                                                                        | Smoke: extensive (create/delete 409/404, last-admin guard).                                                                                                                                |
| `api/sync`, `sync/failed`, `sync/requeue`                                                                  | Smoke: queue + DLQ requeue + member 403.                                                                                                                                                   |
| `api/google/*` (connections, disconnect, discover, map, oauth connect/callback)                            | Smoke: extensive.                                                                                                                                                                          |
| `api/health`, `api/health/ready`, `api/metrics`                                                            | Smoke: liveness/readiness + SUPER_ADMIN-only metrics.                                                                                                                                      |

Count: **at least 19 route handlers have no automated exercise in any suite**
(8 analytics + 5 v1 + insights + integrations/health + reports/send-test +
auth/logout + invites/accept + members/invite/[id] + transfers cancel/reject),
plus `api/organization` GET as a potential 20th. The smoke suite's strength is
concentrated in tenant/security paths; the read/analytics/public-API surface
is the blind spot.

## 4. Mock effectiveness — the known alias issue is fixed; residual risks remain

The brief flagged a known vitest alias issue for `googleapis`/`ioredis`.
**Verified fixed in the current source.** `apps/web/vitest.config.ts`
aliases `googleapis` → `../../packages/google/node_modules/googleapis` and
`ioredis` → `../../packages/shared/node_modules/ioredis`, and both alias
targets exist on disk (`packages/google/node_modules/googleapis/package.json`,
`packages/shared/node_modules/ioredis/package.json` present).

Evidence the mocks are effective (not silently missing):

- `discovery-pagination.test.ts` mocks `googleapis` (`google.analyticsadmin /
searchconsole / adsense`) and asserts exact mock call counts
  (`accountsList` 2×, `propertiesList` 3×). If the mock missed, the real
  client would be constructed with `auth: {}` and the calls would fail, not
  return paged fixtures. 6/6 pass.
- `rate-limit-failclosed.test.ts` mocks `ioredis` with a client whose `eval`
  always throws, sets `REDIS_URL`, and asserts the `ratelimit.redis_error` /
  `ratelimit.fail_closed` counters. A missed mock would attempt a real TCP
  connection to 127.0.0.1:6379 (nothing listening in the sandbox) and the
  test would hang on retries instead of passing in ~1.1s. 2/2 pass.
- `ad-manager-parse.test.ts` stubs the global `fetch` (Ad Manager uses REST
  `fetch`, not the SDK — `packages/google/src/ad-manager.ts:4`); retry test
  asserts exactly 3 calls with 2× 500 then success. Effective.
- `sync-engine.test.ts` does not mock Google modules at all: it injects fake
  `SyncDeps`, so the real engine code runs. This is the correct pattern and
  should be the model for the token/client gaps.

Residual mock risks (A-COV-10):

- The `@metricflock/db`, `@metricflock/auth`, `@metricflock/google/client`,
  and `@metricflock/db/snapshots` barrel mocks in `portfolio.test.ts`,
  `insights-loader.test.ts`, `health.test.ts`, and `api-key-auth.test.ts`
  replace the whole module with a hand-written stub exposing only the methods
  the test expects. If production code adds a second Prisma call, the stub
  returns `undefined` and the test can fail confusingly — or pass vacuously
  if the new call's result is only used in an unasserted branch.
- `insights-loader.test.ts:15` mocks `@/lib/portfolio` (`loadPortfolio`)
  while testing `loadInsights`, which calls `loadPortfolio`. A regression in
  the real `loadPortfolio` is therefore invisible to the insights-loader
  tests; only `portfolio.test.ts` guards it, and the two suites never run
  the real pair together. The same pattern (mocking a sibling loader) is the
  main way a broken behaviour could pass the unit suite.
- Mocks are per-file with no shared fixture: `prisma.website.findMany` is
  stubbed differently in `portfolio` vs `insights-loader` tests, so the two
  suites can disagree about the DB contract without failing.

## 5. Tests that could pass despite broken behaviour (weak assertions)

- **`transfer.test.ts` (3 tests) — tautological.** Test 1 asserts a string
  literal matches its own regex (`"OAuth tokens are never transferred between
owners"` vs `/never transferred/`); test 2 defines a local
  `sameTeam` helper inline and tests it; test 3 asserts a hardcoded 6-element
  status array has length 6. The file's own comment admits it: "Verified by
  code review; this test pins the documented rule so a regression is caught
  in review." No import of `apps/web/src/lib/transfers.ts` or any route.
  A transfer that copied OAuth tokens, accepted same-team transfers, or
  expired transfers incorrectly would pass all 3 tests. (A-COV-03, P1.)
- **`tenant-isolation.test.ts`** — pins cache-key scoping and the permission
  table, not tenant enforcement (see §3.1). Passes even if every `assert*`
  function in `tenant.ts` is deleted, because nothing imports them.
- **`auth-config.test.ts`** — checks hook _presence_ (`typeof ... === "function"`),
  never hook _behaviour_. A hook that returns its input unchanged passes.
- **`permissions.test.ts`** — pins the table; no test that a route actually
  enforces the permission it declares.
- **`validation.test.ts`** — 2 of 8 schemas; the tested ones assert
  accept/reject of statuses, but no test asserts the _error shape_ returned
  to clients for invalid input.
- **Smoke's `auth_post` helper** retries on 429 (`scripts/smoke-test.sh:53-56`),
  which is correct for test stability but means a rate-limit misconfiguration
  that 429s legitimate sign-ins is masked in smoke — the retry loop waits it
  out instead of failing.
- **E2E axe gate** only fails on `critical`/`serious` violations; `moderate`/
  `minor` violations are ignored by construction, and e2e asserts visibility
  of text ("schedule saved", "revoked") rather than the underlying state
  (e.g. the journeys API-key test never calls the API with the created key).

## 6. Flaky-test and determinism risks

- **Real-timer sleeps, no fake timers.** `rate-limit.test.ts:22-25`: a 1 ms
  window with a 5 ms `setTimeout` — passes today but is timing-sensitive
  under a loaded CI runner (a 5 ms sleep is not guaranteed to exceed a 1 ms
  window by a safe margin on a throttled host; conversely the test would
  also pass if expiry were broken and the bucket leaked, because keys are
  random per test — the expiry assertion is the only one covering it).
  `ad-manager-parse.test.ts` retry test sleeps through real backoff
  (~1,715 ms in the local run). `insights-loader.test.ts` tests take
  ~660–700 ms each; `api-error.test.ts` ~312 ms — import cost, not sleeps.
- **Suite duration:** 232.7 s locally, 91% of it module import (Next.js /
  better-auth / Prisma client graph loaded per test file in isolation).
  Vitest itself suggests `isolate: false` would save ~52 s. Slow feedback
  discourages running the suite; there is no split (fast/slow) configuration.
- **Shared mutable state across tests in one file:** `rate-limit.test.ts`
  and `rate-limit-failclosed.test.ts` use `Math.random()` keys and module-level
  counters (`counterSnapshot()` assertions use `>= 1`, which is tolerant but
  also order-dependent if tests are ever run in parallel in one worker).
  `mailer.test.ts` mutates `process.env` with save/restore — correct, but a
  failure between `beforeEach` and `afterEach` restore could leak env into
  later files (mitigated by vitest isolation).
- **CI-only determinism risks (not observable locally):** smoke depends on
  seed ordering ("newest first" website selection, `smoke-test.sh:113-116`),
  `$$` (PID) uniqueness for generated emails/domains, and better-auth's
  3-per-10s sign-in limit; Playwright `retries: 1` in CI can mask a flaky
  e2e test by passing on retry. No flake was observed in the local unit run
  (single run only — flakiness cannot be excluded from one run).

## 7. Findings

Severity: P0 = proven production break / data loss; P1 = a security-relevant
or release-blocking coverage hole; P2 = a significant hole in an important
path; P3 = quality/depth gap. Status CONFIRMED means observed in current
source or in the local run; POTENTIAL means inferred from absence of evidence
(the route/file is never exercised, but no failing behaviour was demonstrated).

### A-COV-01 — P1 — CONFIRMED — Coverage gate measures 8 files, not the repo

- **Location:** `apps/web/vitest.config.ts:20-29` (no `coverage.include` /
  `coverage.all`; thresholds at line 29).
- **Evidence:** local `coverage-final.json` contained exactly 8 files, all in
  `apps/web/src/lib/`; `packages/*`, `apps/worker/*`, and all 52 route files
  are absent. The 99.23% / 92.98% / 96.87% / 100% headline and the 90/80/90/90
  gate therefore say nothing about ~90% of the codebase by file count.
- **Impact:** the gate can pass while tenant enforcement, token refresh, the
  worker, and every API route regress. The config comment itself scopes
  coverage to "modules exercised by the unit suite (pure logic)" and defers
  route/DB coverage to smoke — but smoke has no coverage measurement or gate
  of its own, so the deferral is unmeasured.
- **Correction:** set `coverage: { all: true, include: ["apps/web/src/**",
"packages/*/src/**", "apps/worker/src/**"] }` (or an equivalent root-level
  config) and re-baseline thresholds per directory; add a smoke-route
  checklist assertion (e.g. fail if a route file is added without a smoke or
  unit entry). Until then, do not quote the 99% figure as repo coverage.
- **Regression-test requirement:** a test that fails if `coverage-final.json`
  ever again contains fewer than the expected file set (or a CI step asserting
  the file count); per-module threshold tests for `packages/auth`,
  `packages/google`, `packages/shared`.
- **Dynamic verification 2026-11-23 (retry): suite re-run, finding stands.**
  The full unit suite was re-run locally against the current tree with
  `--hookTimeout=60000`: **38 files / 196 tests pass**, coverage
  **99.23 / 92.98 / 96.87 / 100** — identical to CI #207, and the
  `coverage-final.json` file set is still the same 8 files under
  `apps/web/src/lib/`. The gate still passes while measuring only
  those files.

### A-COV-02 — P1 — CONFIRMED — Tenant-isolation functions have zero unit tests

- **Location:** `packages/auth/src/tenant.ts:5-125` (8 assert/visibility
  functions), `packages/auth/src/server.ts:225,231,239`,
  `packages/auth/src/api-helpers.ts:5`.
- **Evidence:** name search over all 38 unit files: none of the 8 functions
  is referenced. Only smoke (Stage-9/Phase-1, CI-only, NOT RUN here) exercises
  them, over HTTP.
- **Impact:** the P0 security property of the product (cross-tenant isolation)
  has no fast, local regression test. A one-line change in `tenant.ts`
  (wrong comparison, missing org filter) passes `pnpm test:coverage` and is
  caught only if CI smoke runs and its IDOR matrix still covers that path.
- **Correction:** add unit tests with a mocked Prisma client exercising each
  assert for allow/deny/404 cases (same-team vs cross-team, assignee-view vs
  manage, connection scope mismatch), plus a test that `requireApiAuth`
  returns 403/404 for a missing permission.
- **Regression-test requirement:** per-function allow/deny unit tests in a
  new `tenant.test.ts`; a test that deleting an assert breaks the suite.

### A-COV-03 — P1 — CONFIRMED — `transfer.test.ts` is tautological; transfer helpers untested

- **Location:** `apps/web/tests/unit/transfer.test.ts` (whole file);
  `apps/web/src/lib/transfers.ts:11-37` (`OPEN_TRANSFER_STATUSES`,
  `TRANSFER_TTL_MS`, `loadTransferInOrg`, `expireIfStale`,
  `canActForDestination` — none imported by any test).
- **Evidence:** quoted in §5. The test file imports nothing from source.
  Smoke covers accept/complete but never cancel/reject (§3.7), and never
  tests TTL expiry.
- **Impact:** transfer is a money/state-critical workflow (website ownership
  moves between teams). Stale-transfer expiry, same-team rejection, and
  destination-authorization bugs have no automated check anywhere.
- **Correction:** replace the file with real tests: `expireIfStale` with a
  mocked Prisma (stale → expired + audit; fresh → untouched), `loadTransferInOrg`
  org-scoping (foreign org → null/404), `canActForDestination` allow/deny;
  add smoke calls for cancel and reject.
- **Regression-test requirement:** the new `transfer.test.ts` plus smoke
  cancel/reject steps asserting status transitions and that the website does
  not move.

### A-COV-04 — P1 — CONFIRMED — ≥19 route handlers never exercised by any suite

- **Location:** see the route table in §3.7. Worst clusters:
  `apps/web/src/app/api/analytics/{traffic,audience,pages,events,realtime,
search-console,adsense,ad-manager}/route.ts` (8),
  `apps/web/src/app/api/v1/{health,insights,portfolio,websites,
websites/[id]/analytics}/route.ts` (5),
  `apps/web/src/app/api/{insights,integrations/health,reports/send-test,
auth/logout,invites/accept,members/invite/[id]}/route.ts`,
  `apps/web/src/app/api/transfers/[id]/{cancel,reject}/route.ts`.
- **Evidence:** string search of `scripts/smoke-test.sh` (0 matches for each
  path above), of all e2e specs (no direct API calls), and of all unit tests
  (no `route.ts` import). The shared handler
  `apps/web/src/lib/analytics-handler.ts` (`classifyAnalyticsError`,
  `handleAnalyticsRequest`) is imported by no test.
- **Impact:** the entire public API (v1) and 8/9 analytics endpoints are
  unverified: auth, scoping, snapshot-first fallback, and error mapping could
  be broken in production with every suite green. This is the largest
  single blind spot in the repo.
- **Correction:** add route-level tests (invoke handlers with mocked
  `requireApiAuth`/`prisma`/loaders, or extend smoke with one call per route
  asserting status + shape) for at least the v1 and analytics routes; add a
  CI check that every `route.ts` is referenced by smoke or a test.
- **Regression-test requirement:** one happy-path + one unauthenticated +
  one foreign-tenant test per route in the list above.

### A-COV-05 — P2 — CONFIRMED — Worker (692 LOC) has zero tests

- **Location:** `apps/worker/src/index.ts` (351 lines),
  `apps/worker/src/report.ts:29` (`sendOrgReport`),
  `apps/worker/src/scheduler.ts:196` (`startScheduler`); no `test` script in
  `apps/worker/package.json`.
- **Evidence:** `find` for `*.test.ts` under `apps/worker` returns nothing;
  `packages/jobs` tests cover only pure helpers (`planDueSyncs`,
  `staggerDelayMs`, `jitteredBackoffMs`).
- **Impact:** the production sync/report/failure-alert path is never executed
  in any suite. A worker crash loop, a mis-wired queue name, or a report that
  throws for one org would only be found in production.
- **Correction:** extract the per-job processor functions from `index.ts`
  into testable units and test them with injected deps (following the
  `SyncDeps` pattern in `sync-engine.test.ts`); add a smoke step that runs
  the worker briefly against the CI Redis and asserts a queued job completes.
- **Regression-test requirement:** processor unit tests (success, Google
  429 → retry, invalid grant → skip, failure alert sent once); a CI
  worker smoke step.

### A-COV-06 — P2 — CONFIRMED — Token refresh / OAuth flow / Google client untested in unit

- **Location:** `packages/google/src/tokens.ts:113,194`
  (`getValidAccessToken`, `revokeConnection`),
  `packages/google/src/oauth.ts` (`createOAuthFlow`, `consumeOAuthState`,
  `buildAuthUrl`, `getGoogleAccountProfile`),
  `packages/google/src/client.ts` (`resolveConnectionForWebsite`,
  `getAuthorizedClientForIntegration`).
- **Evidence:** `getValidAccessToken` appears in tests only as an injected
  `vi.fn`; `revokeConnection` appears nowhere in tests; the OAuth/client
  functions appear nowhere in tests. Smoke Stage-3 covers state validation
  over HTTP only.
- **Impact:** token refresh expiry, invalid-grant revocation, and the DATA-5
  connection-scoping rule have no local regression test; a refresh bug
  breaks all Google sync silently (syncs return `missing_data` instead of
  erroring loudly, by design).
- **Correction:** unit-test `getValidAccessToken` with a fake encrypted-token
  store (valid / expired-refreshable / invalid-grant paths) and
  `getAuthorizedClientForIntegration` with mismatched-connection fixtures.
- **Regression-test requirement:** refresh-path tests incl. invalid-grant →
  connection marked revoked; scope-mismatch → `SCOPE_MISSING`.

### A-COV-07 — P2 — CONFIRMED — Redis cache read/write/invalidate + env parsing untested · FIXED 2026-11-24

- **Location:** `packages/shared/src/cache.ts:70,88,108,117`
  (`cacheGet`, `cacheSet`, `invalidateWebsiteCache`, `invalidateOrgCache`),
  `packages/shared/src/cache.ts:6,26`, `packages/shared/src/env.ts`
  (`getEnv`, `googleEnabled`).
- **Evidence:** only `buildCacheKey` is unit-tested; `sync-engine.test.ts`
  injects a fake `cacheSet`; no test calls the real cache functions.
- **Impact:** a wrong invalidation key or a cache read that ignores staleness
  causes stale analytics with no failing test; an env-parsing bug can
  silently disable a provider.
- **Correction:** unit-test cache functions against a mocked Redis client
  (fakeredis-style stub): set/get round-trip, stale flag, website/org
  invalidation key patterns; test `getEnv`/`googleEnabled` with controlled
  env vars.
- **Regression-test requirement:** invalidation-pattern tests asserting the
  exact key prefixes invalidated per website/org.
- **Verification note (2026-11-24):** revalidation found the finding's
  evidence stale — the coverage-gap closure had already added
  `lib-cache.test.ts` (12 tests) and `lib-env.test.ts` (6 tests) covering
  `cacheGet`/`cacheSet` (miss/fresh/stale, error/corrupt-JSON), the SCAN
  cursor loop, `getRedis`/`bullConnectionOptions`, `getEnv` and
  `googleEnabled`. What was still missing was closed by this fix (+12
  tests, 30 total in the two files): a true `cacheSet` → `cacheGet`
  round-trip against an in-memory store (fakeredis-style, with a
  snapshot-paged SCAN), store-backed invalidation proving only the target
  website's / org's keys disappear, exact-prefix assertions with negative
  scoping (website pattern matches no sibling website or org), the
  `invalidateOrgCache` no-Redis branch (the one uncovered branch), the
  `getRedis` error-listener registration, an empty-string miss, a
  URL-encoded password in `bullConnectionOptions`, and env edge cases
  (empty `DATABASE_URL`, absent optionals, only exact `'false'` disables).
  Per-file coverage from these tests alone: `cache.ts` 100/100/100/100
  (was 98.18/97.05/88.88/100), `env.ts` 100/100/100/100. Fail-without-fix
  verified twice: widening the website pattern to the org pattern fails
  3 tests; renaming the cache envelope's `value` key to `data` fails
  exactly the round-trip test (the old stub tests cannot catch that).
  No production bug was found — the production code was correct; the
  gaps were test-only. One test-only defect surfaced and was fixed: the
  env test file leaked `GOOGLE_CLIENT_ID` between tests (the `KEYS`
  cleanup list now covers every optional schema key).

### A-COV-08 — P2 — CONFIRMED — 6 of 8 Zod validation schemas untested · FIXED 2026-11-24

- **Location:** `packages/shared/src/validation.ts:2,29,37,48,52,58`
  (`dateRangeSchema`, `teamCreateSchema`, `transferSchema`,
  `analyticsQuerySchema`, `inviteCreateSchema`, `memberRoleSchema`).
- **Evidence:** `validation.test.ts` covers only `websiteCreateSchema` and
  `mapPropertySchema`.
- **Impact:** malformed input (bad date ranges, oversized reasons, invalid
  roles) may reach handlers; error shapes for invalid input are unasserted
  anywhere.
- **Correction:** table-driven schema tests (valid / each invalid field /
  boundary values) for the 6 schemas.
- **Regression-test requirement:** one test file asserting accept/reject +
  error paths per schema.

- **Verification note (2026-11-24):** revalidation found the finding's
  evidence partly stale — `dateRangeSchema` was already covered by the
  A-GGL-08 tests (strict dates, presets). The other 5 schemas
  (`teamCreateSchema`, `transferSchema`, `analyticsQuerySchema`,
  `inviteCreateSchema`, `memberRoleSchema`) were genuinely untested
  despite being used by live routes/handlers. Tests only, no production
  change: `validation.test.ts` extended in place (8 → 23 tests, +15
  table-driven — valid / each invalid field / boundary values, with the
  failing field's issue path asserted per case). `dateRangeSchema` gains
  range-enum + default tests; `teamCreateSchema` includes the `.partial()`
  form the PATCH route uses; `inviteCreateSchema` pins that `SUPER_ADMIN`
  is never granted by invite. Fail-without-fix verified by mutating the
  production schemas (slug regex dropped, transfer reason cap dropped,
  invite role widened to `SUPER_ADMIN`) — exactly the 4 tests guarding
  those constraints failed; schemas restored byte-identical (diff-verified).
  No production bug was found. One mid-session type error in the new test
  helper (`(string | number)[]` vs Zod 4's `PropertyKey[]` issue paths)
  failed `tsc` and the Next build; fixed by typing the helper with
  `PropertyKey[]`, all gates re-run green after the fix. Per-file coverage:
  `validation.ts` 100/100/100/100. Full suite: 121 files, 1,327 tests,
  coverage 95.96/90.58/90.51/97.69 vs thresholds 90/80/90/90.

### A-COV-09 — P2 — CONFIRMED — ESLint does not lint any `.ts`/`.tsx` file · FIXED 2026-11-24

- **Location:** `eslint.config.mjs:11-16` (header comment, verified in current
  source: "the .ts/.tsx files are NOT linted yet" pending typescript-eslint
  TS 7 support), `scripts/check-boundaries.sh` (4 grep checks only).
- **Evidence:** the config uses `@eslint/js` + `react-hooks` only; there is
  no TS parser and no `files: ["**/*.ts", "**/*.tsx"]` block. `pnpm lint`
  (`eslint . && bash scripts/check-boundaries.sh`) therefore passes
  vacuously for all TypeScript. The boundary rules in the config are dormant
  for `.ts/.tsx`; only the 4 grep checks (Google SDK imports, Prisma imports,
  relative cross-package imports, `console.*`) run.
- **Impact:** unused imports/variables, unsafe `any` usage, and the
  boundary rules themselves are unenforced on the code that matters. A
  cross-package import introduced tomorrow would pass `pnpm lint` unless it
  matches one of the 4 grep patterns.
- **Correction:** track typescript-eslint TS 7 support and re-add the parser
  - `files` blocks; meanwhile extend `check-boundaries.sh` (or add a
    `tsc`-based check) for the highest-value rules. Record the gap in CI
    output rather than letting `pnpm lint` print green unqualified.
- **Regression-test requirement:** a CI step asserting ESLint actually lints
  at least one `.ts` file (e.g. `eslint --print-config` check or a deliberate
  lint-error fixture).

- **Verification note (2026-11-24):** interim path taken — latest stable
  typescript-eslint is 8.74.0 with peer range `typescript >=4.8.4 <6.1.0`
  (checked 2026-11-24), so TS 7.0.2 is still unsupported and no stable
  release adds it; a version bump was NOT done (a lockfile change needs a
  separate decision). `scripts/check-boundaries.sh` now enforces all 7
  boundary rules for `.ts`/`.tsx` (Google SDK, Prisma, relative
  cross-package, better-auth, bullmq, ioredis) plus the console check and
  a new explicit-`any` check on src (0 hits; tests out of scope — test
  doubles use `any`, e.g. `worker-index.test.ts`); every check is also run
  against a fixture tree in a self-test that plants one violating fixture
  per rule plus legal-import fixtures that must not trip, so the
  enforcement cannot silently go vacuous. Proof: a planted `googleapis`
  import in `packages/db` fails the real run (exit 1), and breaking the
  google/`any` patterns fails the self-test (exit 1). `pnpm lint` now
  prints two `WARNING (A-COV-09)` lines on every run naming the gap.
  Residual: unused imports/variables are still unenforced — a
  `tsc --noUnusedLocals --noUnusedParameters` run finds 5 violations (4 in
  test files owned by pending fixes, 1 in `packages/db/src/client.ts` —
  the unused `Prisma` import, fixed here); the follow-up is to enable
  `noUnusedLocals`/`noUnusedParameters` in the tsconfigs once those pushes
  land. Full suite unchanged: 121 files, 1,327 tests, coverage
  95.96/90.58/90.51/97.69, gate green.

### A-COV-10 — P2 — CONFIRMED — Barrel mocks can hide real wiring regressions · FIXED 2026-11-24

- **Location:** `apps/web/tests/unit/portfolio.test.ts:12-17`,
  `insights-loader.test.ts:11-15`, `health.test.ts:12-18`,
  `api-key-auth.test.ts` (whole-file `vi.mock` blocks).
- **Evidence:** each file replaces `@metricflock/db` / `@metricflock/auth` /
  `@metricflock/google/client` / `@metricflock/db/snapshots` with a
  hand-written stub exposing only the methods that test needs; §4 documents
  the `insights-loader` → mocked `@/lib/portfolio` case.
- **Impact:** medium. The mocks are correctly scoped (see §4 — the alias
  issue is fixed), but a test can pass while the real module wiring is
  broken, because the stub and the real module can drift apart silently.
- **Correction:** prefer dependency injection (as in `sync-engine.test.ts`)
  over barrel mocks for new tests; add one integration-style test per loader
  that runs the real `loadPortfolio` + `loadInsights` pair against a stubbed
  Prisma only (no stubbed sibling loader).
- **Regression-test requirement:** a test that fails if a loader calls a
  Prisma method the test stub does not provide (e.g. assert on the mock
  factory's completeness, or run loaders against a recording fake).

- **Verification note (2026-11-24):** fixed by adding
  `apps/web/tests/unit/loaders-wiring.test.ts` (6 tests, tests only — no
  production change). The new suite runs the real `loadPortfolio` +
  `loadInsights` pair against a recording fake Prisma only (no stubbed
  sibling loader): `vi.mock("@metricflock/db")` covers the loaders, the
  google client and auth, plus `vi.doMock` on the computed absolute
  `@metricflock/db` client path covers `packages/db/src/snapshots.ts`,
  which imports via `./client` (the same alias gap documented in
  `db-snapshots-seed.test.ts`). The fake is a strict Proxy that throws on
  any Prisma method it does not provide (one allowlisted import-time read:
  better-auth's `prismaAdapter` reads `prisma._runtimeDataModel` while
  building the auth instance — returns `undefined`, exactly as a
  plain-object mock does). Tests assert the exact recorded call set per
  loader (including the A-GGL-07 clamped SC range key and the A-DB-11
  batched single-call-per-method shape), pair consistency between the two
  loaders, and restricted-user scoping through the real
  `listAccessibleWebsiteIds`. Fail-without-fix verified: temporarily
  switching `loadPortfolio` to per-website `getPrimaryIntegration` calls
  fails 4 of 6 tests (the loader's try/catch degrades to an empty primaries
  map, so the result is 0 websites instead of 1); `portfolio.ts` restored
  byte-identical (sha256 verified). The existing barrel-mock suites
  (`portfolio.test.ts`, `insights-loader.test.ts`, `health.test.ts`,
  `api-key-auth.test.ts`) were NOT rewritten — their tests and assertions
  are untouched. Full suite: 122 files, 1,333 tests, coverage
  95.96/90.77/90.51/97.69, gate green.

### A-COV-11 — P3 — CONFIRMED — Weak-assertion inventory (config-shape and pure-function tests) · FIXED 2026-11-25

- **Location:** `auth-config.test.ts` (hooks only `typeof === "function"`),
  `permissions.test.ts`, `tenant-isolation.test.ts`, `audit-retention.test.ts`
  (3 tests on a pure env default), `snapshot-ttl.test.ts`, `cache-keys.test.ts`,
  `pagination.test.ts` (2 tests), `api-error.ts:72-77` (unhandled-error branch
  never executed), `health.ts:74-75`, `insights.ts:98,118-119` (uncovered
  statements in the measured 8 files).
- **Evidence:** read each file; assertion counts are low relative to the
  behaviour they claim (e.g. `pagination.test.ts` has 2 tests / 6 expects for
  the pagination contract used by every list endpoint).
- **Impact:** low individually; collectively the suite pins shapes, not
  behaviours, for auth, tenant, and error paths. The unhandled-error branch
  (generic 500 + `api.internal_error` counter) is the fallback for every
  route and has never been executed in a test.
- **Correction:** invoke the better-auth hooks with fixtures; execute
  `withApiErrors` with a throwing handler and assert the 500 + counter;
  add pagination edge tests (limit 0 / negative / >max / offset beyond total).
- **Regression-test requirement:** hook-invocation tests; `withApiErrors`
  throw-path test; pagination boundary tests.
- **Verification (2026-11-25):** the better-auth database hooks are now
  invoked with fixtures in `auth-config.test.ts` (invite hit/miss
  org+role assignment, slug derivation, client-supplied org/role
  discarded, invite consumption + audit on create.after,
  update.before rejection, sign-in audit) — previously only
  `typeof === "function"` was asserted. The `withApiErrors`
  unhandled branch now asserts the `api.internal_error` counter
  (exactly once per unhandled error; ApiError/Prisma-mapped paths do
  not count) plus the two passthrough branches (malformed-JSON body,
  plain Response); removing the `incr` line fails exactly the new
  counter test. Pagination boundaries pinned (negative limit, exact
  max, fractional floor, empty/Infinity input, under-cap offset
  passthrough, defaultLimit clamps). Full role×permission matrix +
  `extra` grants + unknown role pinned in `permissions.test.ts`;
  cache-key defaults and the org:website prefix order in
  `cache-keys.test.ts`, website/property scoping in
  `tenant-isolation.test.ts`; retention parsing boundaries in
  `audit-retention.test.ts`; all 9 reports + degenerate TTLs in
  `snapshot-ttl.test.ts`. The previously uncovered `health.ts` /
  `insights.ts` statements were already covered by later fixes; the
  remaining branches (non-finite page, missing name/domain, both
  batch-failure catches) are now asserted. **Bug found, not fixed
  here:** `AUDIT_RETENTION_DAYS=0.5` floors to 0 days, so the worker
  cutoff becomes "now" (delete-everything) — contradicting the
  fallback contract; pinned as a skipped test in
  `audit-retention.test.ts` pending a production fix.

### A-COV-12 — P3 — POTENTIAL — Flakiness and suite-speed risks · FIXED 2026-11-25

- **Location:** `apps/web/tests/unit/rate-limit.test.ts:22-25` (1 ms window /
  5 ms sleep, real timers), `ad-manager-parse.test.ts` (real backoff sleeps,
  ~1.7 s), `apps/web/playwright.config.ts` (`retries: 1` in CI),
  `scripts/smoke-test.sh:53-56` (429 retry loop).
- **Evidence:** no `vi.useFakeTimers` anywhere; single local run passed, so
  no flake was observed — this is a risk assessment, not an observed failure
  (hence POTENTIAL).
- **Impact:** timing-sensitive tests can flake on loaded CI runners; suite
  takes 232.7 s locally (91% import), discouraging frequent runs; CI retry
  settings can mask flakes.
- **Correction:** use fake timers for the window-expiry test; cap backoff
  sleeps in tests via injected delay; consider `isolate: false` (vitest
  suggests ~52 s saving) after verifying isolation assumptions; record
  Playwright retry passes distinctly from first-try passes.
- **Regression-test requirement:** a test that asserts the suite contains no
  bare `setTimeout` in tests (lint rule) once fake timers are adopted.
- **Verification (2026-11-25):** the rate-limit window-expiry test now uses
  fake timers (`vi.useFakeTimers` + `vi.setSystemTime` — the in-memory
  limiter reads `Date.now()`, so expiry is proven deterministically; 5/5
  stable runs); the ad-manager retry test drives `admFetch`'s backoff with
  fake timers (`admSleep` is module-private with no injection point, so no
  production seam was added and retry semantics are unchanged; 1709 ms →
  5 ms); `vi.useFakeTimers` is now used across the suite (google-tokens,
  google-ad-manager-extra, worker-scheduler, scheduler-*, rate-limit,
  ad-manager-parse), so the "nowhere" evidence no longer holds. The
  `isolate: false` part was evaluated and rejected by A-PERF-04 (3.5× faster
  but 221 mock-bleed failures). `scripts/smoke-test.sh`'s 429 loop is
  unchanged by design (it waits out better-auth's sign-in limiter in CI
  smoke, documented in the script). Playwright still retries once in CI
  (`retries: 1`); recording retry passes distinctly from first-try passes
  is NOT implemented — the CI dot-reporter log does not distinguish them
  (the HTML report does), and changing the reporter/config is an
  owner-decision follow-up. Regression guard: `no-bare-settimeout.test.ts`
  scans the unit suite and ratchets every remaining bare
  `setTimeout`/`setInterval` to a per-file count with a justification
  (mock network latency for busy-state assertions, real worker/server
  lifecycle waits, fake-timer-driven mocks, one wall-clock deadline test);
  demonstrated failing on a temporary bare `setTimeout` and passing after
  its removal.

### A-COV-13 — P3 — CONFIRMED — UI and e2e journey coverage is thin · FIXED 2026-11-25

- **Location:** `apps/web/tests/e2e/journeys.spec.ts` (5 tests),
  `apps/web/src/app/**/*.tsx` (20 pages, ~15 client components, 0 component
  tests).
- **Evidence:** e2e covers team create, website create, API-key create/revoke,
  report-schedule save, mobile nav. No e2e for transfers, members/invites,
  sync requeue, integrations/discovery, health, insights, audit, or
  settings/security flows; axe gate ignores `moderate`/`minor` violations.
- **Impact:** UI regressions (a form that renders but never submits, a button
  wired to the wrong handler) are caught only by the smoke script's
  `grep`-for-text checks on 4 pages, which assert presence of text, not
  behaviour.
- **Correction:** add one journey per major management flow (transfer
  accept/complete via UI, invite accept, sync requeue) and component tests
  for the form components once a test renderer is added.
- **Regression-test requirement:** journey tests asserting the resulting
  server state (e.g. transfer status after UI accept), not just visible text.
- **Verification (2026-11-25):** revalidation found the component-test
  half already closed by later fixes — every client form component now
  has component tests (transfers: `TransferActions.test.tsx` +
  `WebsiteActions.test.tsx` transfer form; members/invites:
  `MemberForms.test.tsx` + `AcceptInviteButton` clicks in
  `AuthForms.test.tsx`; sync: `RequeueButton` clicks in
  `AuthForms.test.tsx`; integrations/discovery:
  `ConnectionActions.test.tsx`; health/insights/audit:
  `pages-ops.test.tsx` / `pages-insights-integrations.test.tsx`;
  settings/security: `SecurityActions.test.tsx` + the 2FA-QR and
  session-revoke e2e specs). The remaining gaps were exactly the three
  named e2e journeys, now added to `journeys.spec.ts`, each asserting
  server state via the API: transfer accept + complete from
  `/transfers` (website team unchanged after accept, flipped to the
  destination after complete; both transitions audited), invite
  accept for an existing account from `/invite/<token>` (invitee's
  session shows the inviting org + `TEAM_MEMBER` role; accept
  audited), and dead-letter requeue from `/sync` (job leaves
  `/api/sync/failed`; requeue audited). Preconditions the public API
  cannot create (a verified invitee, a terminally FAILED job) use the
  repo's own CI fixture scripts (`smoke-verify-user.ts`,
  `smoke-failed-job.ts`), as `smoke-test.sh` does; transfer completion
  relies on the smoke stage-2 fixture's ACTIVE connection on team-b.
  The axe gate in both accessibility specs now blocks on all four
  impact levels (moderate/minor no longer ignored). The new journeys
  and the tightened gate are CI-only verification (no DB/Redis
  locally); integrations/discovery e2e remains impossible without a
  real Google account and stays component-covered.

### A-COV-14 — P3 — CONFIRMED — DB write paths untested in unit

- **Location:** `packages/db/src/audit.ts:23` (`writeAudit`),
  `packages/db/src/snapshots.ts:15,42,49`, `packages/db/src/health.ts`
  (`lastSuccessfulSync`).
- **Evidence:** name search over unit tests: none referenced (except
  `readSnapshot`, which is mocked, never executed).
- **Impact:** audit completeness (a compliance-relevant property) and
  snapshot write/invalidate correctness have no fast test; smoke asserts
  audit presence only for a few flows.
- **Correction:** unit-test `writeAudit`/`writeSnapshot`/invalidation against
  a mocked Prisma client asserting the exact `create`/`deleteMany` calls.
- **Regression-test requirement:** Prisma-call-shape tests for each write
  function.

### A-COV-15 — P3 — CONFIRMED — No per-file thresholds; aggregate hides a 50% file

- **Location:** `apps/web/vitest.config.ts:29`; measured `api-key-auth.ts`
  functions 50% (see §0 table) while the aggregate functions figure is
  96.87% and the gate passes.
- **Evidence:** per-file table in §0.
- **Impact:** a file can lose half its functions and the gate still passes.
- **Correction:** add per-file thresholds (vitest supports
  `thresholds` per file via `coverage.thresholds` with file patterns in
  newer versions, or a script asserting per-file minima from the JSON
  report) once A-COV-01's scope fix lands.
- **Regression-test requirement:** CI assertion on per-file minimums from
  `coverage/coverage-final.json`.

### A-COV-16 — P3 — CONFIRMED — Auth email sending paths untested

- **Location:** `packages/auth/src/mailer.ts`
  (`sendVerificationEmail`, `sendPasswordResetEmail` — never named in tests);
  `mailer.test.ts` covers only `mailerMode` and `sendMail` log-preview behaviour.
- **Evidence:** name search; smoke exercises reset/verification over HTTP
  (which proves the SMTP/dev path works end-to-end in CI) but no unit test
  pins the email contents, recipients, or the preview-vs-SMTP branching for
  the two credential-email senders.
- **Impact:** low — smoke covers the flow in CI. A template regression
  (wrong reset URL, missing token) would pass unit tests.
- **Correction:** unit-test both senders with a stubbed transport asserting
  recipient, subject, and that the URL contains the token and no token leaks
  to logs.
- **Regression-test requirement:** sender unit tests with a recording
  transport.

## 8. What is good (for balance — verified, not assumed)

- **Parser and pure-logic coverage is genuinely strong.** GA4/Search
  Console/AdSense/Ad Manager parsers, crypto, redaction, rate-limit
  fail-closed, discovery pagination (incl. loop guard and page cap), and the
  sync engine (14 tests, dependency-injected) are well asserted, including
  edge cases (total-CTR recomputation, quota → `SyncRateLimitError`,
  revoked grant → `skipped`).
- **The mock-alias issue is fixed.** Both `googleapis` and `ioredis` aliases
  resolve to existing paths and the mocks demonstrably intercept (§4).
- **Smoke is the strongest part of the suite** on paper: 36 checkpoints,
  real Postgres/Redis, a 9-probe IDOR matrix, and lifecycle coverage (TOTP,
  password reset with session revocation, backup/restore drill). Its value is
  real — but it is CI-only, unmeasured, and was NOT RUN in this audit, so
  none of it is verified here.
- **No skipped tests, no `.only`, no TODO-marked tests** in the unit or e2e
  suites. The suite is green locally (196/196) with no failures to hide.
- **No test was found to depend on network access** except the mocked ones;
  the local run passed with no Postgres/Redis running.

## 9. Verdict

| Area                                  | Verdict                     | Basis                                                                                         |
| ------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| Unit tests pass locally               | **PASS**                    | 196/196, 38 files, exit 0, 2026-11-23.                                                        |
| Coverage gate (as configured)         | **PASS** (but see A-COV-01) | 99.23/92.98/96.87/100 vs 90/80/90/90. The pass is vacuous for most of the repo.               |
| Coverage scope / gate meaningfulness  | **FAIL**                    | A-COV-01, A-COV-15: only 8 files measured; no per-file thresholds.                            |
| Tenant isolation (unit level)         | **FAIL**                    | A-COV-02: zero unit tests for `tenant.ts` asserts; smoke-only.                                |
| Transfer workflow tests               | **FAIL**                    | A-COV-03: tautological unit tests; cancel/reject untested anywhere.                           |
| API route coverage                    | **FAIL**                    | A-COV-04: ≥19 of 52 route handlers never exercised by any suite.                              |
| Worker / background jobs              | **FAIL**                    | A-COV-05: 692 LOC, 0 tests; `enqueue`/`getQueue` untested.                                    |
| Token refresh / OAuth / Google client | **FAIL**                    | A-COV-06: refresh and revoke paths never directly tested.                                     |
| Cache / env                           | **FAIL**                    | A-COV-07: real cache functions and env parsing untested.                                      |
| Validation schemas                    | **FAIL**                    | A-COV-08: 6 of 8 schemas untested.                                                            |
| Lint coverage of TypeScript           | **FAIL**                    | A-COV-09: ESLint does not lint `.ts`/`.tsx`; only 4 grep checks run.                          |
| Mock effectiveness (alias issue)      | **PASS**                    | §4: aliases exist and mocks demonstrably intercept. Residual barrel-mock risk: A-COV-10 (P2). |
| Smoke test (CI)                       | **NOT RUN**                 | Needs Postgres + Redis + built app; not runnable in this sandbox. Read as evidence only.      |
| Playwright e2e (CI)                   | **NOT RUN**                 | Needs built app + seeded DB; not runnable in this sandbox. Read as evidence only.             |
| Full CI pipeline                      | **NOT RUN**                 | No GitHub access from this audit; CI run history unverified.                                  |
| Flakiness                             | **NOT RUN** (risk noted)    | A-COV-12: single local run passed; flakiness cannot be excluded from one run.                 |

**Overall Phase 9 verdict: FAIL (not production-ready on test-coverage grounds
alone).** The unit suite is green and the pure-logic core is well tested, but
the coverage gate measures 8 files out of ~120 source files, the tenant
isolation that the product's security rests on has no unit test, ≥19 API
routes (including the whole public v1 API and 8 of 9 analytics endpoints)
are never executed by any suite, and the worker that performs all background
sync has zero tests. None of these is a demonstrated production bug — no P0
was found — but each is a hole a regression can pass through with every suite
green. The smoke suite, if green in CI, mitigates the tenant and route gaps
for the paths it covers; it does not cover the v1 API, most analytics routes,
the worker, or token refresh, and its CI status was not verified in this audit.

## 10. Finding counts

| Severity  | Count  | IDs                                                        |
| --------- | ------ | ---------------------------------------------------------- |
| P0        | 0      | —                                                          |
| P1        | 4      | A-COV-01, A-COV-02, A-COV-03, A-COV-04                     |
| P2        | 6      | A-COV-05, A-COV-06, A-COV-07, A-COV-08, A-COV-09, A-COV-10 |
| P3        | 6      | A-COV-11, A-COV-12, A-COV-13, A-COV-14, A-COV-15, A-COV-16 |
| **Total** | **16** |                                                            |

## 11. Limits of this audit (honest statement)

- No `.git` in the sandbox copy: HEAD `6e6d2b21` could not be verified; the
  audit is of the files on disk as found.
- No Postgres, Redis, Docker, or network access to the production app: smoke
  and e2e were read, not run; their CI results were not verified. Any finding
  that says "covered by smoke" rests on reading the script, not observing it
  pass.
- Coverage numbers come from a single local run (`/tmp/cov.log`); the
  generated `apps/web/coverage/` HTML/JSON artifacts were present during the
  run and are gitignored (`coverage/` in `.gitignore`).
- "Untested" means: the function/route name appears in no unit test, no e2e
  spec, and no smoke-test string match, as checked by search on 2026-11-23.
  A route exercised only via a UI flow is credited as such in §3.7; indirect
  coverage through a shared helper is not credited as route coverage.
- No regression tests were added in this audit (per the brief, tests are
  optional; gaps are documented with test requirements instead). No files
  other than this document were written; no branches, commits, pushes,
  deploys, refactors, or behaviour changes were made.
