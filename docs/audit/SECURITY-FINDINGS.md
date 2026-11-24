# Security Findings — Revalidation @ `810faea5` (2026-11-21)

Every finding from the brief was revalidated against the current code.
Verdicts: **CONFIRMED** (exists now), **POTENTIAL** (possible under
conditions), **ALREADY-RESOLVED** (fixed by the Stages 1–9 program or
later work; evidence cited).

## Summary

| ID     | Finding                                                                                                | Severity | Verdict                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------- |
| F-1.1  | Website PATCH/DELETE use view-level access check                                                       | High     | CONFIRMED                                                 |
| F-1.2  | Website create / team reassignment: same-org check only                                                | High     | CONFIRMED                                                 |
| F-1.3  | Property mapping doesn't verify connection visibility/owner scope                                      | High     | CONFIRMED (within-org)                                    |
| F-1.4  | Inconsistent permission-check patterns; undocumented role semantics                                    | Medium   | CONFIRMED                                                 |
| F-2.1a | userinfo called without identity scopes                                                                | Medium   | CONFIRMED                                                 |
| F-2.1b | Ad Manager scope never requested                                                                       | Medium   | CONFIRMED                                                 |
| F-2.1c | Granted scopes stored but never inspected                                                              | Low      | CONFIRMED                                                 |
| F-2.1d | No reauthorization detection for scope changes                                                         | Low      | CONFIRMED                                                 |
| F-2.2  | OAuth state/callback binding                                                                           | —        | ALREADY-RESOLVED (2 minor notes)                          |
| F-2.3  | Mailer logs full auth URLs when SMTP unset; pretend-success                                            | High     | CONFIRMED                                                 |
| F-2.4  | Token crypto                                                                                           | —        | ALREADY-RESOLVED (1 minor note)                           |
| F-2.5  | better-auth configuration                                                                              | —        | ALREADY-RESOLVED (minor notes)                            |
| F-3.1  | Rate limiter silently degrades to per-process memory; XFF-trusted keys; no metrics; invites un-limited | High     | CONFIRMED                                                 |
| F-3.2  | Refresh lock fails open when Redis down / lock timeout                                                 | High     | CONFIRMED (lock itself sound)                             |
| F-3.3  | Discovery pagination: single-page, silent truncation                                                   | Medium   | CONFIRMED                                                 |
| F-3.4  | Ad Manager: no scope, no pagination/retry/timeout, CTR-total bug, unlabeled beta                       | Medium   | CONFIRMED                                                 |
| F-4.1  | Schema composite FKs / partial uniques                                                                 | —        | ALREADY-RESOLVED core; 3 POTENTIAL gaps                   |
| F-4.2  | Transfer lifecycle                                                                                     | —        | ALREADY-RESOLVED (1 cosmetic note)                        |
| F-4.3  | User/org deletion, export, retention policy                                                            | Medium   | CONFIRMED gap                                             |
| F-5.4  | Dashboards read live-on-miss; snapshots Redis-only                                                     | Medium   | CONFIRMED (target not met)                                |
| F-5.5  | Queue reliability                                                                                      | —        | ALREADY-RESOLVED (no jitter/priorities — Low)             |
| F-5.6  | Unbounded dashboard-page queries                                                                       | Low      | CONFIRMED                                                 |
| F-6.7  | Audit scrubbing key-based only; raw provider errors stored/emailed                                     | Medium   | CONFIRMED gap                                             |
| F-6.8  | CSP `unsafe-inline` scripts, broad `img-src`, no nonce                                                 | Medium   | CONFIRMED (documented tradeoff)                           |
| F-6.9  | Supply chain (SHA pins, Dependabot, CodeQL, Semgrep, gitleaks)                                         | —        | ALREADY-RESOLVED on `main` (SBOM/provenance absent — Low) |

---

## Phase 1 — Tenant isolation & authorization (P0)

### F-1.1 Website PATCH/DELETE authorization — CONFIRMED, High

- **Files:** `apps/web/src/app/api/websites/[id]/route.ts` (`patch` ~L26–29, `del` ~L82–85); `packages/auth/src/tenant.ts:16–35` (`assertWebsiteAccess`), `:36–48` (`assertWebsiteManageAccess`).
- **Evidence:** PATCH/DELETE call `requireApiAuth("website.manage")` (role-level permission) then `assertWebsiteAccess`, which passes for SUPER_ADMIN, an `isAdmin` member of the website's team, **or any user with a per-website assignment** (view-level). `assertWebsiteManageAccess` (SUPER_ADMIN or `isAdmin` of the website's team; assignment explicitly insufficient) exists and is used by the property-map route, but not here.
- **Scenario:** A user with the TEAM_ADMIN _role_ who is merely assigned to a website in a team they do not administer passes both checks and can PATCH (including moving the website to another team in the org) or DELETE it.
- **Correction:** PATCH/DELETE use `assertWebsiteManageAccess`; GET keeps `assertWebsiteAccess`.
- **Regression tests (smoke):** assigned viewer with TEAM_ADMIN role cannot PATCH/DELETE; TEAM_MEMBER cannot; `isAdmin` of owning team can; SUPER_ADMIN can; cross-org → 404.

### F-1.2 Website creation & team reassignment — CONFIRMED, High

- **Files:** `apps/web/src/app/api/websites/route.ts:48–56` (POST), `apps/web/src/app/api/websites/[id]/route.ts:36–43` (PATCH `teamId`).
- **Evidence:** both verify only that `teamId` belongs to the caller's organization. No check that the caller can manage the destination team (create), or the current + destination teams (reassignment). Reassignment check-then-update is not transactional.
- **Scenario:** TEAM_ADMIN creates websites in any org team, or moves a website into/out of teams they don't administer.
- **Correction:** verify team-management authority (`assertTeamAccess` semantics: SUPER_ADMIN or `isAdmin` membership) for the destination team on create; for PATCH, on current and destination teams; perform reassignment in a transaction.
- **Regression tests:** Team Admin A cannot create in Team B; cannot move into/out of Team B; SUPER_ADMIN can; cross-org rejected; failed reassignment leaves ownership/integrations unchanged.

### F-1.3 Connection/property mapping isolation — CONFIRMED (within-org), High

- **Files:** `apps/web/src/app/api/google/properties/map/route.ts:23` (`connFilter = { organizationId, … }`), `:61` (`assertWebsiteManageAccess` ✓); `packages/auth/src/tenant.ts:57–88` (`connectionVisibilityWhere`, `assertConnectionVisible`); `packages/google/src/client.ts:9–90`.
- **Evidence:** mapping requires manage access to the website and a genuinely discovered property, org-scoped — cross-organization is safe. But the resolved connection is never checked with `assertConnectionVisible`, and its owner scope (team/website) is never verified against the target website. Discover/disconnect _do_ apply visibility checks; mapping doesn't.
- **Scenario:** Team Admin A maps a property discovered under Team B's Google connection to Team A's website — cross-team credential binding inside one org.
- **Correction:** after resolution, load the connection, `assertConnectionVisible`, and verify owner scope matches the website (team connection of the website's team, or that website's own connection); enforce in the service layer as well as the route.
- **Regression tests:** Team A cannot map via Team B's connection; property of Connection A cannot be mapped via Connection B; same-team mapping still works; cross-org still 404.

### F-1.4 Permission model consistency — CONFIRMED, Medium

- **Files:** `packages/auth/src/permissions.ts`, `tenant.ts`, `api-helpers.ts`; all API routes.
- **Evidence:** three roles (SUPER_ADMIN/TEAM_ADMIN/TEAM_MEMBER) + `TeamMember.isAdmin` + `WebsiteAssignment`. `requireApiAuth(permission)` is role-level; routes combine it inconsistently with visibility asserts (`assertWebsiteAccess`) vs manage asserts (`assertWebsiteManageAccess`). `assertTeamAccess` correctly requires `isAdmin` for TEAM_ADMIN role.
- **Correction:** document the matrix (SUPER_ADMIN = org owner/admin; TEAM_ADMIN role + `isAdmin` membership = team admin; assignment = website viewer), standardize manage-asserts on every mutating route, add matrix tests. Do not change role semantics silently.

## Phase 2 — Auth, OAuth, secrets (P1)

### F-2.1a userinfo without identity scopes — CONFIRMED, Medium

- **Evidence:** `packages/google/src/oauth.ts:5–8` requests only the three API scopes; `getGoogleAccountProfile()` (`oauth.ts:110–117`) calls oauth2 v2 `userinfo.get`, which needs an identity scope. Works today only because better-auth Google sign-in (same client) requests `email/profile/openid` and `include_granted_scopes: true` (`oauth.ts:138`). An email/password user connecting a fresh Google account gets `oauth=failed`, no connection.
- **Correction:** add `openid` + `email` to connect scopes. **Tests:** connect flow with no prior identity grant creates the connection with correct `googleAccountEmail`.

### F-2.1b Ad Manager scope never requested — CONFIRMED, Medium

- **Evidence:** `buildAuthUrl(..., extraScopes = [])` (`oauth.ts:118–140`) supports extras; the only caller (`connect/route.ts:26`) never passes `admanager.readonly`. `ad-manager.ts` calls then 403 on every request.
- **Correction:** pass the scope when `GOOGLE_AD_MANAGER_ENABLED`. **Tests:** auth URL contains scope iff flag on.

### F-2.1c Granted scopes stored, never inspected — CONFIRMED, Low

- **Evidence:** stored at `callback/route.ts:81,96`; displayed at `connections/route.ts:24`, `integrations/page.tsx:102`; no per-provider scope checks anywhere.
- **Correction:** check stored scopes before provider calls; surface "needs reauthorization" state.

### F-2.1d No reauthorization detection — CONFIRMED, Low

- **Evidence:** reconnect upserts tokens+scopes with `prompt=consent` (works), but nothing detects missing scopes or prompts reauth.
- **Correction:** reauth-required flag on connections missing required scopes + UI prompt. **Tests:** missing-scope connection surfaces reauth state; reconnect updates scopes.

### F-2.2 OAuth state/callback binding — ALREADY-RESOLVED

HMAC timing-safe + fail-closed secret (`crypto.ts:87–101`); atomic one-time consume with 10-min TTL, only `nonceHash` stored (`oauth.ts:96–107`, `schema.prisma:333–346`); PKCE S256 (`oauth.ts:17–24`); userId match (`callback/route.ts:38–39`); owner re-validated at connect and callback (`callback/route.ts:57`). Minor notes: `organizationId` persisted but not explicitly compared at callback (transitively safe — add explicit check); session binding is user-level, not session-id; state consumed before session check (by design). Confirm org-mismatch + PKCE-mismatch cases exist in smoke.

### F-2.3 Mailer logs auth URLs — CONFIRMED, High

- **Evidence:** `packages/auth/src/mailer.ts:20–24` logs the full body (incl. verification/reset URLs) when SMTP is unset; no `NODE_ENV` gate; `sendMail` returns `void` → pretend-success; `instrumentation.ts` only warns at startup in production.
- **Scenario:** production without `SMTP_HOST` → every password-reset link in server logs; anyone with log access can reset any account; users never receive mail.
- **Correction:** production: never log bodies (recipient + subject only) and throw or fail startup; full-body preview only behind an explicit dev flag. **Tests:** prod no-SMTP logs no URL; dev preview still usable.

### F-2.4 Token crypto — ALREADY-RESOLVED

AES-256-GCM, fresh 12-byte IV per encryption, tag length pinned to 16 both sides (`crypto.ts:48–64`), versioned `v1:<keyId>:` envelope, AAD on every call site, rotation window + lazy re-encryption, `TOKEN_KEY_UNKNOWN`, legacy decrypt, zero plaintext-token logging found. Minor: unknown envelope _version_ falls into the legacy branch (fails closed at GCM) — add explicit version check for diagnosability.

### F-2.5 better-auth configuration — ALREADY-RESOLVED

`requireEmailVerification`, min password 12, `revokeSessionsOnPasswordReset`, `freshAge` 15 min, TOTP, account-linking protections (`requireLocalEmailVerified`), mass-assignment closed (`server.ts`). Minor notes: `rateLimit` not explicitly configured (library defaults + custom login wrapper); no explicit `useSecureCookies`; no lockout/breached-password screening (AUTH-12 deferred).

## Phase 3 — Rate limiting, refresh, pagination (P1)

### F-3.1 Rate limiting — CONFIRMED, High

- **Evidence:** `packages/shared/src/rate-limit.ts:39–49` silently falls back to per-process memory when Redis is unset/down. Only 4 call sites (login, oauth-connect, oauth-callback, google sync). Login key is the **raw** `x-forwarded-for` header (`login/route.ts:19`); callback uses its first entry; `proxy.ts` doesn't sanitize XFF (Vercel sets it in the current deployment, but the code documents/enforces no trusted-proxy assumption). No `incr()` metrics for rejections/fallback/Redis errors. Invite creation is not rate-limited; better-auth endpoints rely on library defaults.
- **Scenario:** Redis outage → login limit becomes per-instance with no alert; XFF rotation bypasses buckets where the platform doesn't overwrite the header.
- **Correction:** per-endpoint policy (fail-closed for sensitive ops when Redis is configured but down, or an explicitly alarmed degraded mode); trusted IP derivation; `ratelimit.rejected/fallback/redis_error` counters; limit invite creation. **Tests:** Redis-down per endpoint class; spoofed XFF shares one bucket; concurrency; multi-instance; metrics emitted.

### F-3.2 Refresh lock fails open — CONFIRMED, High (lock itself sound)

- **Evidence:** `packages/google/src/tokens.ts:15–42` — correct distributed lock (SET NX PX 30 s, ownership token, spin 15 s, compare-and-delete release, double-checked re-read). Fail-open: `if (!redis) return fn()` and `if (!acquired) return fn()` — Redis down or contention timeout → **unlocked refresh**. 30 s TTL without renewal/fencing (POTENTIAL).
- **Scenario:** two unlocked refreshes race; the stale write overwrites a rotated refresh token → `invalid_grant` → connection REVOKED.
- **Already-resolved parts:** failed refresh never overwrites valid tokens; only structured `invalid_grant` revokes; revocation audit-logged.
- **Correction:** fail closed (retryable error) when Redis is configured but the lock is unavailable; unlocked mode only for explicit no-Redis single-instance deployments, logged + metered; consider fencing check before DB write. **Tests:** concurrent refresh → exactly one Google call; lock timeout → no unlocked refresh; rotated token persisted is the winner's; transient 5xx leaves tokens byte-identical.

### F-3.3 Discovery pagination — CONFIRMED, Medium

- **Evidence:** `packages/google/src/discovery.ts` — GA4 `accounts.list({pageSize:200})` + `properties.list({pageSize:200})` single-page, `nextPageToken` ignored; one account's error fails all GA4 discovery. AdSense `accounts.list({pageSize:50})`, Ad Manager `/networks?pageSize=50` — same. Search Console `sites.list` has no pagination (N/A). No `truncated` indicator. Adjacent: GSC _analytics_ pagination is correct (`search-console.ts:52–69`, `truncated` surfaced); GA4 `runReport` has no limit/offset (10k default cap, POTENTIAL).
- **Correction:** follow `nextPageToken` with page cap + loop guard + `truncated` surfacing; per-account error isolation. **Tests:** multi-page fixtures, empty final page, repeated-token guard, page-2 error → flagged partial.

### F-3.4 Ad Manager — CONFIRMED, Medium

- **Evidence:** REST v1 via `fetch`, gated default-off (good). Scope missing (F-2.1b). Parser defensive, never invents numbers (ALREADY-RESOLVED). **Bug:** totals sum `AD_SERVER_CTR` across rows (meaningless; test even asserts it). No pagination, no date validation (`toParts` slices → `NaN` possible), no timezone handling, no retry/backoff/timeout. Networks absent from discover route (worker sync only). Beta marking exists in code comment only — not in UI/README.
- **Correction:** incremental scope + reauth; pagination; date validation; bounded retry + timeout; CTR totals recomputed or omitted; beta label in UI + README until live-validated. **Tests:** scope iff enabled; 403 classified; multi-page networks; invalid date rejected pre-fetch; 429 bounded retry; CTR total correct.

## Phase 4 — Data integrity & lifecycle

### F-4.1 Schema constraints — ALREADY-RESOLVED core; 3 POTENTIAL gaps

Exists: Website↔Team composite same-org FK `Restrict` (`schema.prisma:223`), connection typed owner FKs composite same-org `Cascade` (`:300,:302`) + both-owners CHECK (stage2 migration:75), single-primary partial unique index (stage2:94–96), one-open-transfer partial unique index (stage7 migration:11–13), property↔connection uniques (`:357–390`).
Gaps: (1) `WebsiteIntegration` FKs are single-column — DB doesn't enforce `googleProperty.connectionId = googleConnectionId` or org equality (app-layer only); (2) owner CHECK allows both FKs NULL (legacy columns still present); (3) `TeamMember.userId`/`WebsiteAssignment.userId` single-column (app-layer org checks only).
**Correction:** composite FKs or transactional service checks + integration tests; tighten CHECK to exactly-one when legacy columns drop.

### F-4.2 Transfer lifecycle — ALREADY-RESOLVED

Transactional completion, state guards (409), lazy 7-day expiry, destination authority, ACTIVE-connection requirement, partial-unique backstop, smoke coverage. Minor: initiate race surfaces raw P2002 500 instead of clean 409 (cosmetic; integrity protected).

### F-4.3 Deletion & retention — CONFIRMED gap, Medium

Website delete ✓ (cascades + audit), team delete ✓ (409 while websites remain), disconnect ✓ (revoke + clear, row retained). **Missing:** user deletion (no endpoint; `Restrict` FKs would block naive deletion), org deletion (only internal shell-org cleanup; `AuditLog` Restrict blocks orgs with history), data export, retention policy (only `AnalyticsSyncJob` 30-day pruning exists; no AuditLog/cache retention, nothing documented).
**Correction:** define + document policy first (org deletion vs audit retention, user anonymization, export), then implement. **Tests:** delete-user-with-connections, org-delete matrix, export completeness.

## Phase 5 — Workers, performance, scalability

### F-5.4 Dashboard data path — CONFIRMED (5.1 target not met), Medium

Cache-aside with single-flight lock → **live Google call on miss** (`analytics-handler.ts`); "snapshots" are TTL'd Redis entries written by the worker to the same keys; the `AnalyticsCache` DB table has **no callers**. Cache keys include org/website/property/source/report/range/filters (no teamId/connectionId — safe by construction); SCAN-based invalidation (no `KEYS`); invalidation on map/transfer/disconnect/delete ✓. Org aggregate is an honest stub (`aggregate_requires_per_website_call`).
**Correction (if pursuing 5.1):** persist worker snapshots and serve dashboards from them; refresh enqueues jobs. **Tests:** dashboard renders with Google unreachable; freshness labels correct.

### F-5.5 Queue reliability — ALREADY-RESOLVED

Attempts 5 + exponential backoff (no jitter — Low), stable dedup jobIds, durable `AnalyticsSyncJob` rows, per-connection rate limiting with delay-not-fail, per-queue limiters, backpressure depth 40, Redis-locked scheduler with pagination, DLQ list/requeue + failure emails. Missing: job priorities (acceptable now), stalled-job tuning beyond defaults.

### F-5.6 DB performance — CONFIRMED (Low)

API list routes all paginated (default 50, max 200). Unbounded: `(app)/dashboard/page.tsx:17–33` loads all org websites/connections/integrations + O(W×I) JS scan — fine at ~100 sites, costly at 1k–10k. No N+1 found in checked routes; indexes comprehensive.

## Phase 6 — Audit, CSP, supply chain

### F-6.7 Audit scrubbing — CONFIRMED gap, Medium

`scrubAuditDetails` (`packages/db/src/audit.ts:3–15`) drops credential-_named keys_ recursively, but string _values_ pass untouched (`Bearer …`, `?token=` under innocuous keys stored verbatim). No live leak at current call sites (ids/domains/emails only). Adjacent: raw provider error text persisted (`AnalyticsSyncJob.lastError`, `IntegrationHealth.lastError`) and emailed raw to SUPER_ADMINs; `errMeta` puts raw `e.message` in logs.
**Correction:** value-level redaction (Bearer patterns, token/key query params, long base64/hex) + shared `sanitizeProviderError` before store/email/log. **Tests:** nested objects + arbitrary strings with secrets → redacted everywhere.

---

## Remediation status

- **2026-11-21 — Phase 1 (F-1.1, F-1.2, F-1.3, F-1.4) implemented locally,
  pending push + CI smoke verification.** Changes: `assertTeamManageAccess`
  and `assertConnectionScopeForWebsite` added to `tenant.ts`; website
  PATCH/DELETE and assign switched to `assertWebsiteManageAccess`; create
  and PATCH `teamId` require manage access to the destination team
  (reassignment transactional); map route enforces
  `assertConnectionVisible` + ownership scope (`400
connection_scope_mismatch`); permission matrix documented in
  `docs/security/overview.md`; regression tests in `scripts/smoke-test.sh`
  ("phase1" section) + team-b property fixture in `smoke-stage2.ts`.
  Local verification: format/lint/typecheck/unit tests/build green.
  Smoke suite requires Postgres+Redis (CI) — verdict pending CI run.
  **Update 2026-11-21: pushed (01386e73), CI #183 SUCCESS — smoke
  phase1 section green, IDOR matrix intact. Phase 1 closed.**
- **2026-11-21 — Phase 2 (F-2.1a–d, F-2.2 note, F-2.3, F-2.4 note,
  F-2.5 notes) implemented locally, pending push + CI.** Changes:
  `openid`+`email` added to connect scopes; `admanager.readonly`
  requested only when Ad Manager enabled; `missingScopesForProvider` /
  `providersMissingScopes` helpers + `SCOPE_MISSING` fail-fast in
  `getAuthorizedClientForIntegration` (classified `scope_missing`);
  connections API exposes `needsReauth`/`missingProviders`; Integrations
  page shows "Reconnect needed" with reconnect link; callback rejects
  `org_mismatch`; mailer never logs bodies (preview only via
  `EMAIL_LOG_PREVIEW=true`, error-level recipient+subject log otherwise);
  crypto rejects unknown envelope versions (`TOKEN_ENVELOPE_UNSUPPORTED`);
  better-auth `rateLimit` pinned (credential endpoints 3/10s) +
  production secure cookies. Tests: new `oauth-scopes.test.ts`,
  `mailer.test.ts`, crypto + auth-config additions — all green locally
  (format/lint/typecheck/tests/build). Smoke already covers
  forged/expired/wrong-session/PKCE-presence/replay; org-mismatch and
  PKCE-verifier-mismatch cannot be exercised without a real Google
  exchange (verifier never leaves the server).
  **Update 2026-11-21: pushed (fb061401), CI #184 SUCCESS — 115 unit
  tests, smoke ALL CHECKS PASSED, e2e 4/4. Phase 2 closed.**
- **2026-11-21 — Phase 3 (F-3.1, F-3.2, F-3.3, F-3.4) implemented
  locally, pending push + CI.** Changes: `rateLimit` gained a
  `failClosed` policy — Redis-configured-but-down now rejects sensitive
  callers (login, OAuth connect/callback, invite creation) with
  `ratelimit.*` counters on /api/metrics instead of silently degrading;
  `clientIpFromHeaders` (x-real-ip → first XFF entry) replaces raw-header
  keys; invite creation rate-limited (20/min/inviter). Refresh lock fails
  closed (`TOKEN_REFRESH_LOCK_UNAVAILABLE`, classified
  `temporarily_unavailable`) on Redis error or 15s contention; unlocked
  only in explicit no-Redis mode (logged + counted); fencing check skips
  the refresh-token overwrite when the lock was lost and the stored
  token changed. Discovery paginates GA4 accounts/properties, AdSense
  accounts and Ad Manager networks (10-page cap, token-loop guard,
  `truncated` surfaced in the discover API); GA4 per-account failures
  isolated (`partial.ga4Accounts`); GA4 historical reports flag
  `truncated` when rowCount exceeds returned rows. Ad Manager: 15s
  timeout + bounded retries (429/5xx/network, no retry on other 4xx),
  strict date validation (`AD_MANAGER_INVALID_DATE`), total CTR
  recomputed from clicks/impressions (was summed per-row), beta label in
  README + Integrations UI + report note. Tests: client-ip,
  rate-limit-failclosed (mocked ioredis), refresh-lock
  (acquired/timeout/error), discovery-pagination (mocked googleapis),
  ad-manager CTR/date/retry/pagination additions.
  **Update 2026-11-21: pushed (daef93f7); CI #185 FAILED on a test-env
  bug only — the ioredis mock did not intercept in CI (ioredis is
  @metricflock/shared's dep; CI's real Redis service answered instead).
  Fixed by aliasing ioredis in vitest.config.ts; pushed 2026-11-22
  (d759d72e) — CI #186 SUCCESS (26 files/138 tests, smoke ALL CHECKS
  PASSED, e2e 4/4). Phase 3 closed.**
- **2026-11-22 — Phase 4.1/4.2 (F-4.1, F-4.2 note) implemented
  locally, pending push + CI.** Migration
  `20261122000000_phase4_db_integrity`: TeamMember/WebsiteAssignment
  gain `organizationId` (backfilled from team/website) + composite FKs
  to Team/Website and User (new `User @@unique([id, organizationId])`
  target); WebsiteIntegration property FKs become composite with
  `googleConnectionId` (mapped property must belong to the
  integration's connection; `@@unique([id, connectionId])` targets on
  the four property tables); GoogleConnection owner CHECK tightened to
  exactly-one typed owner after a defensive legacy backfill. Create
  sites updated (members/assign routes, smoke fixture). F-4.2:
  transfer initiate maps the P2002 race to the stable
  `transfer_in_progress` 409 (the central handler already returned a
  generic 409 `conflict`). Regression tests: smoke-stage2 Phase 4
  section asserts Postgres itself rejects cross-connection mapping,
  ownerless connection, cross-org membership and cross-org assignment.
  **Deploy requires `pnpm db:migrate` BEFORE deploying this code** (new
  NOT NULL columns); the migration fails loudly if existing rows
  violate the new constraints. F-4.3 (deletion/retention/export) still
  needs a policy decision.
- **2026-11-22 — Phase 4.3 (F-4.3) implemented locally on Gulzaib's
  approval of the proposed policy, pending push + CI.** Policy doc:
  `docs/security/data-lifecycle.md`. Member deletion
  (`DELETE /api/members/[id]`, member.manage; self/last-super-admin
  guards; 409 `member_has_dependencies` with counts when the user
  created connections/transfers; audit `member.deleted`; Delete button
  on Members page). Organization deletion (`DELETE /api/organization`,
  organization.manage + slug confirmation; best-effort Google token
  revocation; audit rows + org deleted in one transaction; logged
  server-side; Members page Organization card). Org export
  (`GET /api/organization/export`, organization.manage; JSON download;
  credentials/tokens never included; audit `organization.exported`).
  Retention: worker prunes OAuthState (>1 day past expiry),
  AnalyticsCache (expired), AuditLog (`AUDIT_RETENTION_DAYS`, default
  365, parsed in `@metricflock/shared/retention`). Tests: smoke
  phase4 section (member delete + guards + deleted-user sign-in 401;
  export contains no token/password fields; org delete slug-gated,
  deleted owner sign-in 401) + `audit-retention.test.ts`. **Phase 4
  complete locally (4.1 + 4.2 + 4.3).**
  **Update 2026-11-22: pushed (cdde45f2) — CI #187 SUCCESS (27
  files/141 tests, smoke ALL CHECKS PASSED incl. the phase4
  data-lifecycle line, e2e 4/4). The smoke-stage2 DB-constraint
  assertions ran inside the fixture (its stdout is captured into a
  shell variable, so the confirmation line is not in the CI log; any
  failed assertion would exit the fixture non-zero and fail the smoke
  step). Phase 4 closed. Deploy note: production must run
  `pnpm db:migrate` before deploying this commit.**
- **2026-11-22 — Phase 5 (5.2–5.4) implemented locally, pending push
  - CI; 5.1 (F-5.4) awaiting Gulzaib's architecture decision.**
    F-5.5: jittered exponential backoff (`jitteredBackoffMs` in
    @metricflock/jobs, 60s base doubling, 1h cap, 0.5–1.0 jitter factor;
    registered as every Worker's custom backoffStrategy; queue default
    backoff type "custom") + job priorities (`JOB_PRIORITY`: manual 1,
    requeue 2, realtime 5, scheduled 10 — wired into sync route,
    requeue route, scheduler bulk). F-5.6: dashboard page fully bounded
    — COUNT/groupBy aggregates instead of loading all rows, website
    table paginated (50/page), connections list capped at 50, last-sync
    groupBy scoped to the page; provider counts now scoped to
    accessible websites (previously org-wide for restricted users).
    Brief 5.3: `packages/db/scripts/benchmark-scale.ts` (scratch-org
    DB benchmark at 100/1k/10k, prod-host refusal guard) +
    `docs/audit/BENCHMARKS.md` — local JS simulation: old O(W×I)
    connected-count took 3,019 ms at 10k websites vs 8.75 ms for the
    single-pass shape (~345×); DB timings pending a staging run (no
    Postgres in sandbox). Tests: `job-backoff.test.ts` (jitter bounds,
    priority ordering). Verified locally: format/lint ✓, turbo
    typecheck/test/build 10/10 ✓ (146 tests; one transient web#test
    failure under parallel load, green on re-run).
    **F-5.4 hybrid implemented 2026-11-22 on Gulzaib's choice
    ("Hybrid rakho — snapshot pehle, miss par live"):** new
    `@metricflock/db/snapshots` (write/read/invalidate over the
    previously-unused AnalyticsCache table); read order in
    analytics-handler is now Redis → fresh DB snapshot (labeled
    `freshness: "snapshot"`, re-warms Redis) → live Google (writes
    both layers); stale snapshot is the provider-error fallback after
    stale Redis. Worker sync writes snapshots for every synced report
    (optional `writeSnapshot` dep; failures never fail the sync).
    Snapshot freshness = max(cache TTL, sync interval) via
    `snapshotTtlSeconds` in @metricflock/jobs (google package gained a
    workspace dep on jobs). Invalidation: all 6 Redis-invalidation
    call sites now also invalidate snapshots (map, assign, website
    PATCH, transfer complete, disconnect, OAuth callback); website/org
    deletion cascades via FK. Tests: `snapshot-ttl.test.ts`. Verified:
    format/lint ✓, turbo 10/10 ✓. **Phase 5 complete locally.**
    **Update 2026-11-22: pushed (79771777) — CI #188 SUCCESS (29
    files/149 tests, smoke ALL CHECKS PASSED, e2e 4/4). Phase 5
    closed.**

### F-6.8 CSP — CONFIRMED (documented tradeoff), Medium

`script-src 'self' 'unsafe-inline'` (dev adds `unsafe-eval`), `style-src 'unsafe-inline'`, `img-src 'self' data: https:` (broad), no nonce mechanism (comment in `next.config.ts` tracks it as future work). Compensating headers solid (HSTS, DENY framing, nosniff, Referrer/Permissions-Policy).
**Correction:** nonce-based script-src via `proxy.ts`; narrow `img-src` to actual sources. **Tests:** e2e header assertions extended; auth/charts still work.

### F-6.9 Supply chain — ALREADY-RESOLVED on `main`

All workflows SHA-pinned with least-privilege `permissions:`; gitleaks + `pnpm audit` gate + coverage in CI; CodeQL (consistent v3 SHAs, security-extended); Semgrep SAST; Dependabot npm+actions grouped weekly (incl. `codeql` group). Gaps (Low): no SBOM, no build provenance; `pip install semgrep` unpinned in security-audit workflow. (Local-tree staleness found in Phase 0 was fixed by re-syncing from `main`.)

- **2026-11-22 — Phase 6 (F-6.7, F-6.8, F-6.9 notes) implemented locally,
  pending push + CI verification.** F-6.7: new
  `packages/shared/src/redact.ts` (`redactSecrets` for Google OAuth
  tokens, JWTs, Bearer values, key=value secrets, secret URL params,
  the `v1:` token envelope; `sanitizeProviderError` for
  store/email/log paths). Applied at: `scrubAuditDetails` string
  values (db gained a workspace dep on shared), `errMeta`, the
  `recordHealth` storage boundary, worker `lastError` + failure-alert
  emails, sync-engine health writes, and the analytics handler's
  error log. Tests: `redact.test.ts` (6) + audit-scrub value test.
  F-6.8: nonce-based CSP moved to `proxy.ts` (`script-src 'self'
'nonce-…' 'strict-dynamic'`, dev keeps `unsafe-eval`; `style-src`
  keeps `unsafe-inline` for style attributes; `img-src` narrowed to
  `'self' data:`); root layout reads `x-nonce` (dynamic rendering);
  static CSP removed from `next.config.ts`. Verified locally against
  a production server: nonce header present, framework script tags
  carry the nonce. e2e extended (nonce assertions + zero CSP
  violations on /login). F-6.9: semgrep pinned to `1.185.0` in
  security-audit.yml (workflow file — uploaded by Gulzaib, not pushed
  by Kai); `pnpm sbom` script added (CycloneDX via cdxgen 12.9.3,
  output gitignored). Verified: format/lint ✓, turbo 10/10 ✓
  (156 unit tests), `pnpm audit --prod` clean.
  **Update 2026-11-22: pushed (1b01b0c2) — CI #189 failed at the
  Format check only (this file unformatted); fix pushed (02d96e56) —
  CI #190 SUCCESS (30 files/156 tests, smoke ALL CHECKS PASSED,
  e2e 5/5). Phase 6 closed.**
