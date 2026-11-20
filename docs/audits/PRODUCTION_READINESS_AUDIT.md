# MetricFlock — Production Readiness Audit (Phase 0)

|                  |                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repository**   | https://github.com/zuhandeveloper/metricflock                                                                                                                                                                                                                                                                                                                                            |
| **Audit branch** | `security-hardening/production-readiness`                                                                                                                                                                                                                                                                                                                                                |
| **Base commit**  | `b2b17d1a` (main)                                                                                                                                                                                                                                                                                                                                                                        |
| **Audit date**   | 2026-11-20                                                                                                                                                                                                                                                                                                                                                                               |
| **Method**       | Static code inspection of the full repository (100 source files, 26 API routes, Prisma schema + migrations, worker/queues, CI). Library-source verification for better-auth 1.7.26. **No live exploitation, no live Google account, no load test was performed.** Every finding below was verified against current code; claims from the brief that did not hold are marked NOT PRESENT. |
| **Status**       | Phase 0 complete. No code changes made. Implementation starts only after owner approval.                                                                                                                                                                                                                                                                                                 |

---

## 1. Executive summary

**93 findings**: 4 Critical, 24 High, 38 Medium, 27 Low (severity as assessed per finding; a few cross-references between areas describe the same root cause from different angles and are cross-linked).

The application has a sound skeleton — every API route authenticates, zod validation is universal, tenant asserts exist and are mostly enforced, tokens are encrypted at rest with AES-256-GCM, cache keys are tenant-scoped, and **no fake analytics data exists anywhere**. The problems concentrate in four places:

1. **Authentication mass assignment (release-blocking).** better-auth `additionalFields` for `role` and `organizationId` are client-settable at sign-up and via `update-user`. Any user can promote themselves to `SUPER_ADMIN` or move into another organization. The org-provisioning hook trusts a client-supplied `organizationId`. (AUTH-1/2/3)
2. **Cross-tenant integrity gaps in the Google data path.** Website create/PATCH accept a `teamId` from another organization; the OAuth connect/callback never validate the target team/website; connection resolution ignores `organizationId`. A tenant can bind its Google connection into another tenant's namespace and have its tokens used for that tenant's syncs. (API-1/2, OAUTH-6, DB-1/2)
3. **Analytics correctness.** GA4 realtime active users are double-counted (row sums across 7 dimensions), Search Console average position is unweighted, Search Console totals are computed over a truncated 1,000-row page, and property mappings never record which Google connection they belong to. (DATA-1/2/3/5, OAUTH-9, DB-7)
4. **Worker scalability ceiling.** The realtime scheduler produces 1 job/website/minute against a Redis-global limiter of 20/minute — breakeven is **20 websites**, one fifth of the product's stated 100+ target; beyond that the queue grows unboundedly (~115k jobs/day at 100 sites). (OPS-2)

Plus one immediate operational risk: the seed creates a **known-password SUPER_ADMIN** (`demo@example.com`) with no production guard, and the seed has previously been run against the real database (DB-5).

**Bottom line:** MetricFlock is **not production-ready**. It has unresolved Critical findings in authentication and tenant isolation. All are fixable with focused, well-understood changes — none require re-architecture.

---

## 2. Production readiness scorecard

Per the brief §20 classification. PASS = verified with evidence; PARTIAL = implemented but incompletely verified; FAIL = known issue; NOT TESTED = insufficient evidence.

| Area                                 | Rating         | Basis                                                                           |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------- |
| Authentication security              | **FAIL**       | AUTH-1/2/3 mass assignment; AUTH-9 no email verification                        |
| Authorization correctness            | **FAIL**       | API-1/2, OAUTH-6 cross-tenant writes; AUTH-7 scoped-role inconsistencies        |
| Tenant isolation                     | **FAIL**       | DB-1/2 no DB-level org integrity; resolution queries unscoped                   |
| OAuth security                       | **FAIL**       | OAUTH-1/2/4/5/6 state lifecycle; OAUTH-4/CI-1 fallback secret                   |
| Credential encryption                | **PARTIAL**    | AES-256-GCM core is correct; no key versioning/rotation (OAUTH-7)               |
| Database integrity                   | **PARTIAL**    | Good uniques/cascades; polymorphic owner + missing composite FKs (DB-1/2/3)     |
| Analytics correctness                | **FAIL**       | DATA-1/2/3/5 wrong numbers presented as exact                                   |
| API reliability                      | **PARTIAL**    | Authn+validation universal; no rate limits, weak error contract (API-8/9)       |
| Queue reliability                    | **FAIL**       | OPS-2 capacity, OPS-3 idempotency, OPS-4 no DLQ, OPS-10 connections             |
| Rate limiting                        | **FAIL**       | OPS-1 in-memory per-instance; most routes unlimited                             |
| Performance                          | **PARTIAL**    | DB-9 unbounded lists; OPS-11 scheduler scans; no budgets measured               |
| Scalability                          | **FAIL**       | OPS-2 breakeven at 20 websites vs 100+ target                                   |
| Observability                        | **FAIL**       | No metrics/tracing/health endpoints (OPS-4/9); audit log partial (DB-10)        |
| Backup and recovery                  | **NOT TESTED** | No backup/restore procedure documented or tested                                |
| Accessibility                        | **FAIL**       | FE-3 labels/focus/aria largely absent                                           |
| CI/CD                                | **PARTIAL**    | Real CI + smoke test green; lint vacuous for TS, no supply-chain gates (CI-3/4) |
| Documentation                        | **PARTIAL**    | 20 docs incl. ADRs; security/ops/testing docs missing, README stale (CI-8)      |
| Real Google integration verification | **NOT TESTED** | No Google account has ever been connected end-to-end                            |
| Security testing                     | **FAIL**       | 48 unit tests; zero DB-backed authz/IDOR/OAuth regression tests (CI-6)          |
| Load testing                         | **NOT TESTED** | Capacity numbers are arithmetic from code constants, not measured               |

---

## 3. Findings register (summary)

Severity key: **C** Critical · **H** High · **M** Medium · **L** Low. Detail for each finding follows in §4.

### Authentication & authorization (AUTH)

| ID      | Sev | Title                                                                               |
| ------- | --- | ----------------------------------------------------------------------------------- |
| AUTH-1  | C   | Mass assignment: `role`/`organizationId` client-settable at sign-up                 |
| AUTH-2  | C   | Self-service privilege escalation via `POST /api/auth/update-user`                  |
| AUTH-3  | C   | Create hook trusts client-supplied `organizationId`; non-transactional provisioning |
| AUTH-4  | H   | No startup secret validation; library default secret in non-production              |
| AUTH-5  | H   | Hardcoded fallback secret for OAuth-state HMAC (= OAUTH-4)                          |
| AUTH-6  | H   | Primary login path bypasses better-auth rate limiting; in-memory limiter only       |
| AUTH-7  | M   | Global role vs `TeamMember.isAdmin` inconsistently enforced                         |
| AUTH-8  | M   | Google connections org-wide visible/disconnectable by any TEAM_ADMIN (= API-3)      |
| AUTH-9  | H   | No email verification; Google account-linking enables pre-hijacking                 |
| AUTH-10 | M   | Password reset flow non-functional (no mailer)                                      |
| AUTH-11 | L   | 30-day sessions; no account status, no session management                           |
| AUTH-12 | L   | Password policy = library minimum (8 chars)                                         |
| AUTH-13 | L   | `baseURL` silently falls back to localhost                                          |

### API routes & multi-tenancy (API)

| ID     | Sev | Title                                                                            |
| ------ | --- | -------------------------------------------------------------------------------- |
| API-1  | H   | Cross-organization `teamId` accepted on website create/update (= DB-2)           |
| API-2  | H   | Connection resolution + OAuth binding ignore organization (= OAUTH-6)            |
| API-3  | M   | Connections org-wide for any TEAM_ADMIN (= AUTH-8, OAUTH-11)                     |
| API-4  | M   | Transfer completes instantly; no acceptance; stuck `TRANSFER_PENDING` (= DB-4)   |
| API-5  | M   | Member management: no last-admin/self protection; silent demotion                |
| API-6  | M   | TEAM_MEMBER list endpoints over-expose vs detail endpoint                        |
| API-7  | M   | Mapping accepts unverified `externalId`; duplicate primaries (= OAUTH-9, DB-3/7) |
| API-8  | M   | No rate limiting on API routes; sync abusable by view-only members               |
| API-9  | L   | Unhandled Prisma errors → 500; raw provider messages to clients                  |
| API-10 | L   | CSV export: no quoting / formula-injection protection (= DATA-11)                |
| API-11 | L   | Clients can set lifecycle `status` (`SOLD`/`TRANSFER_PENDING`) directly          |
| API-12 | L   | Pagination absent or silently truncating on list endpoints                       |
| API-13 | L   | Global role vs membership-admin mismatch in website access (= AUTH-7)            |

### Google OAuth, encryption, mapping (OAUTH)

| ID       | Sev | Title                                                                               |
| -------- | --- | ----------------------------------------------------------------------------------- |
| OAUTH-1  | H   | OAuth state replayable; nonce generated but never consumed                          |
| OAUTH-2  | H   | Callback unauthenticated; trusts `userId` from state; no session binding            |
| OAUTH-3  | L   | Signature comparison `!==`, not constant-time                                       |
| OAUTH-4  | H   | Hardcoded fallback state-signing secret; env schema never enforced (= AUTH-5, CI-1) |
| OAUTH-5  | M   | No PKCE                                                                             |
| OAUTH-6  | H   | Connect/callback never validate owner ownership — cross-tenant connection injection |
| OAUTH-7  | M   | Encryption sound; no key versioning/rotation; no AAD                                |
| OAUTH-8  | M   | Token refresh uncoordinated; transient errors flip status (= OPS-8)                 |
| OAUTH-9  | H   | Mapping never records connection; `externalId` unverified; multiple primaries       |
| OAUTH-10 | —   | Redirect URI fixed from env — **PASS** (claim not present)                          |
| OAUTH-11 | M   | Connections list org-wide; dead role ternary (= API-3)                              |
| OAUTH-12 | L   | Raw errors to clients; no OAuth rate limiting; sentinel token value                 |

### Database & data integrity (DB)

| ID    | Sev | Title                                                                       |
| ----- | --- | --------------------------------------------------------------------------- |
| DB-1  | H   | Polymorphic GoogleConnection owner, no FK, no validation (= OAUTH-6)        |
| DB-2  | H   | Cross-org relations possible; no composite FKs (= API-1)                    |
| DB-3  | M   | Duplicate "primary" integrations per website+provider                       |
| DB-4  | H   | Transfer state split across two models; no completion path (= API-4)        |
| DB-5  | H   | Seed creates known-password SUPER_ADMIN, no production guard                |
| DB-6  | M   | Orphaned connections when owner team/website deleted                        |
| DB-7  | M   | Typed mapping FK columns never populated (= OAUTH-9)                        |
| DB-8  | M   | Index gaps on hot scheduler/resolution paths                                |
| DB-9  | M   | Unbounded `findMany` on list pages; wrong "connected" count (= DATA-4)      |
| DB-10 | M   | Audit log partial coverage; `ipAddress` never recorded; cascades with org   |
| DB-11 | L   | Sequential upserts in discovery (N+1 writes)                                |
| DB-12 | L   | Over-fetching full connection rows incl. encrypted tokens in RSC            |
| DB-13 | L   | Redundant indexes                                                           |
| DB-14 | L   | No soft-delete; no retention for growth tables                              |
| DB-15 | M   | Single-org-per-user + global role design constraint                         |
| DB-16 | L   | Schema hygiene (free-string statuses, plaintext better-auth Account tokens) |

### Worker, queues, cache, rate limiting (OPS)

| ID     | Sev   | Title                                                                    |
| ------ | ----- | ------------------------------------------------------------------------ |
| OPS-1  | H     | In-memory Map rate limiter; per-instance, unbounded growth               |
| OPS-2  | **C** | Realtime production 5× processing capacity at 100 sites; unbounded queue |
| OPS-3  | H     | Job side effects not idempotent; duplicate rows; unbounded growth        |
| OPS-4  | H     | No dead-letter handling; silent job death; no correlation IDs            |
| OPS-5  | M     | No graceful shutdown; SIGTERM never reaches the app                      |
| OPS-6  | H     | Redis `KEYS` invalidation; no stampede protection; stale never served    |
| OPS-7  | M     | Scheduler lock never released/renewed; >55s ticks interleave             |
| OPS-8  | H     | Token refresh uncoordinated; status flapping (= OAUTH-8)                 |
| OPS-9  | M     | Worker Dockerfile single-stage; no healthcheck/endpoint                  |
| OPS-10 | H     | All BullMQ workers share one ioredis connection (wrong config)           |
| OPS-11 | M     | Scheduler tick = full-table scans every 60s; sequential enqueues         |
| OPS-12 | L     | Dead config (`ga4DailyMinutes`), silent no-op enqueue paths              |

### Analytics correctness (DATA)

| ID      | Sev | Title                                                                    |
| ------- | --- | ------------------------------------------------------------------------ |
| DATA-1  | H   | GA4 realtime active users double-counted (row sums)                      |
| DATA-2  | H   | Search Console average position unweighted (CTR is correct)              |
| DATA-3  | H   | Search Console totals over truncated 1,000-row page                      |
| DATA-4  | M   | "Connected websites" counts all sites if any integration mapped (= DB-9) |
| DATA-5  | H   | Mapping never persists/verifies connection (= OAUTH-9)                   |
| DATA-6  | M   | Portfolio aggregation not implemented (honest stub)                      |
| DATA-7  | M   | GA4 sampling/thresholding metadata ignored                               |
| DATA-8  | L   | GA4 summary defaults missing totals to 0                                 |
| DATA-9  | M   | Ad Manager unparsed; AdSense numbers never rendered                      |
| DATA-10 | L   | "stale-while-revalidate" label on freshly fetched data                   |
| DATA-11 | M   | CSV export injection (= API-10)                                          |
| DATA-12 | L   | Redis `KEYS`; cache key lacks connection dimension (= OPS-6)             |

### Frontend & UX (FE)

| ID   | Sev | Title                                                      |
| ---- | --- | ---------------------------------------------------------- |
| FE-1 | M   | No loading/error/not-found boundaries; Skeleton unused     |
| FE-2 | M   | "Source: undefined" on API errors; `isError` never checked |
| FE-3 | M   | Accessibility basics largely absent                        |
| FE-4 | L   | Freshness/source indicators missing on most cards          |
| FE-5 | L   | Raw metric keys shown to users; AdSense shows row count    |
| FE-6 | L   | Hardcoded `metricflock.com` in SEO metadata                |

### CI, testing, docs, env (CI)

| ID   | Sev | Title                                                          |
| ---- | --- | -------------------------------------------------------------- |
| CI-1 | H   | Env validation is dead code; HMAC fallback secret (= OAUTH-4)  |
| CI-2 | M   | No security headers in code                                    |
| CI-3 | M   | CI lint step vacuous for TypeScript (documented TS7 gap)       |
| CI-4 | M   | Tag-pinned actions; no Dependabot/CodeQL/secret-scan/audit     |
| CI-5 | L   | CI runs no format:check/coverage                               |
| CI-6 | M   | Referenced DB-backed integration tests do not exist            |
| CI-7 | L   | `minimumReleaseAge: 0` (stale wrangler rationale)              |
| CI-8 | M   | Security/ops/testing/product docs missing; README + plan stale |
| CI-9 | L   | Husky pre-commit runs typecheck only                           |

---

## 4. Detailed findings

Format per finding: severity, affected files, root cause, exploitation/failure scenario, business impact, recommended solution, required tests, verification status. All findings verified by code inspection at `b2b17d1a` unless noted.

### 4.1 Authentication & authorization

#### AUTH-1 — Mass assignment at sign-up (Critical)

- **Files:** `packages/auth/src/server.ts:64-69`; `apps/web/src/app/api/auth/[...all]/route.ts:8`
- **Root cause:** `role` and `organizationId` additionalFields have no `input: false`. In better-auth 1.7.26, `parseInputData` only blocks fields with `input === false`; otherwise client values flow into user creation. `role` is a Prisma enum, so `"SUPER_ADMIN"` passes DB validation.
- **Scenario:** `POST /api/auth/sign-up/email {name, email, password, organizationId: "<victim-org>", role: "SUPER_ADMIN"}` → account inside the victim org with full rights. Sign-up is publicly mounted; no CAPTCHA, no email verification.
- **Impact:** Complete cross-tenant takeover. Release-blocking.
- **Fix:** `input: false` on both fields; `user.create.before` hook that unconditionally strips/overrides them.
- **Tests:** sign-up with role/org in body → ignored/rejected; user lands in fresh server-provisioned org.

#### AUTH-2 — Privilege escalation via update-user (Critical)

- **Files:** `packages/auth/src/server.ts:64-69`; no `user.update.before` hook exists.
- **Root cause:** better-auth `update-user` spreads additionalFields into the update. Any authenticated user can set own `role`/`organizationId`. `getSessionUser` re-reads the DB row per request, so escalation is instant.
- **Scenario:** A `TEAM_MEMBER` sends `POST /api/auth/update-user {"role":"SUPER_ADMIN"}` → org-wide super admin. Needs no secret knowledge — the cleanest exploit in this audit.
- **Fix:** `input: false` + `user.update.before` rejecting role/org changes; role changes only via audited admin endpoints.
- **Tests:** member update-user with role/org → rejected, DB unchanged.

#### AUTH-3 — Create hook trusts client `organizationId` (Critical)

- **Files:** `packages/auth/src/server.ts:40-52`
- **Root cause:** `if (u.organizationId) return { data: user }` — client input (incl. role) preserved, provisioning skipped. Provisioning also non-transactional (org created before user insert; failure orphans the org); slug uses `Math.random()`.
- **Fix:** Always provision server-side in a transaction; ignore incoming org/role; invited users join orgs only via server-side invite flow.
- **Tests:** sign-up with foreign org ID → new org; failure mid-provision → no orphan org.

#### AUTH-4 — No startup secret validation (High)

- **Files:** `packages/auth/src/server.ts:57`; `packages/shared/src/env.ts:5-38` (dead code — `getEnv()` has zero callers)
- **Root cause:** If `BETTER_AUTH_SECRET`/`SESSION_SECRET` are unset, better-auth substitutes its published `DEFAULT_SECRET` (throws only when `NODE_ENV=production`; silently used in dev/test/preview). The zod env schema is never executed. `env.ts:29` also contains a build-placeholder secret that becomes live if `getEnv()` is wired into a build path.
- **Fix:** Validate env at startup (instrumentation); require ≥32-char secret in all environments; fail fast.
- **Tests:** boot without secret → refuses to start in every NODE_ENV.

#### AUTH-5 / OAUTH-4 / CI-1 — Hardcoded fallback HMAC secret (High)

- **Files:** `packages/shared/src/crypto.ts:30`; `packages/shared/src/env.ts:21-38`
- **Root cause:** `process.env.SESSION_SECRET ?? "missing-session-secret"` signs OAuth state. If the env var is ever unset in a deployment, the HMAC key is a public string from source → arbitrary state forgery (any userId/ownerId). Contrast `getEncryptionKey` (`crypto.ts:6`) which correctly throws.
- **Fix:** Throw when unset; enforce env schema at startup; consider a dedicated `OAUTH_STATE_SECRET`.
- **Tests:** `hmacState` throws without secret; app boot fails without `SESSION_SECRET`.

#### AUTH-6 — Login bypasses better-auth rate limiting (High)

- **Files:** `apps/web/src/app/api/auth/login/route.ts:22-34`; `packages/shared/src/rate-limit.ts:1-14`; `packages/auth/src/server.ts` (no `rateLimit` config)
- **Root cause:** The login wrapper calls `auth.api.signInEmail` internally, bypassing better-auth's router-level limiter (incl. its `/sign-in` special rule). Only protection is an in-memory per-instance Map (10/min/IP) — on Vercel serverless each instance resets it; key is raw `x-forwarded-for`.
- **Fix:** Redis-backed limiter (per-IP + per-account); configure better-auth `rateLimit` with Redis secondary storage, enabled in all envs.
- **Tests:** >N failed logins across two instances → 429; state survives restart.

#### AUTH-7 / API-13 — Global role vs `isAdmin` inconsistency (Medium)

- **Files:** `packages/auth/src/tenant.ts:13,23,28,44-54`; `packages/auth/src/permissions.ts:22-46`
- **Root cause:** `assertTeamAccess` requires `isAdmin` for TEAM_ADMIN, but `assertWebsiteAccess:28` grants any global TEAM_ADMIN who is merely a member. `listAccessibleWebsiteIds` gives TEAM_MEMBERs all team websites while detail access requires an explicit assignment — list/detail policies disagree (see API-6).
- **Fix:** Make `isAdmin` authoritative in `assertWebsiteAccess`; align list policy with detail policy; longer term, scoped membership roles.
- **Tests:** non-admin TEAM_ADMIN member of team B → denied; member without assignment → absent from list.

#### AUTH-8 / API-3 / OAUTH-11 — Connections org-wide for any TEAM_ADMIN (Medium)

- **Files:** `apps/web/src/app/api/google/connections/route.ts:8-9` (dead ternary — both branches identical); `disconnect/route.ts:14-18`; `discover/route.ts:14-17`
- **Root cause:** Any `google.connection.view/manage` holder (incl. TEAM_ADMIN) lists and can disconnect every connection in the org. Tokens are correctly excluded by `select` (no secret leak).
- **Fix:** Scope by team membership; org-wide only for SUPER_ADMIN.
- **Tests:** Team A admin cannot list/disconnect Team B connections.

#### AUTH-9 — No email verification; pre-hijacking via account linking (High)

- **Files:** `packages/auth/src/server.ts:24,31`
- **Root cause:** Password accounts are active with unverified emails; `accountLinking.trustedProviders: ["google"]` links Google sign-in to an existing password account with the same email.
- **Scenario:** Attacker pre-registers `victim@company.com` with own password; victim's later Google sign-in links into the attacker's account; attacker keeps password access.
- **Fix:** `requireEmailVerification: true` + mailer; link Google only to verified accounts.
- **Tests:** unverified account restricted; Google sign-in does not silently link to unverified password account.

#### AUTH-10 — Password reset non-functional (Medium)

- **Files:** `packages/auth/src/server.ts:24` (no `sendResetPassword`); no mailer anywhere.
- **Fix:** Real mailer, single-use expiring tokens, session revocation on reset.

#### AUTH-11 — Session lifecycle gaps (Low)

30-day sessions, no `freshAge` on sensitive ops, no account status flag, no admin session revocation (`server.ts:59-62`).

#### AUTH-12 — Password policy = library minimum (Low)

8-char minimum, no breached-password screening (`server.ts:24`).

#### AUTH-13 — `baseURL` falls back to localhost (Low)

`server.ts:58` — misconfigured deployments compute OAuth redirects/cookie security against http://localhost:3000 instead of failing fast.

### 4.2 API routes & multi-tenancy

#### API-1 / DB-2 — Cross-org `teamId` on website create/update (High)

- **Files:** `apps/web/src/app/api/websites/route.ts:45`; `websites/[id]/route.ts:40`; `packages/shared/src/validation.ts:18`; `schema.prisma:187-188`
- **Root cause:** `teamId` written verbatim, no org-scoped team lookup; DB has only single-column FKs, no composite constraint tying `team.organizationId = website.organizationId`. Bogus teamId → unhandled FK 500.
- **Scenario:** Org A admin attaches a website to Org B's team; via API-2 its analytics resolve through Org B's Google connection; the site becomes unreachable for its own team admins.
- **Fix:** Org-scoped team resolution before write (404 if absent); composite FK at DB level; map Prisma errors to 400/409.
- **Tests:** foreign teamId → 404; nonexistent → 400; same-org → 201.

#### API-2 / OAUTH-6 / DB-1 — Connection resolution & OAuth binding ignore organization (High)

- **Files:** `packages/google/src/client.ts:13-15,25-27`; `oauth/connect/route.ts:5-12`; `oauth/callback/route.ts:30,38,55`; `schema.prisma:246` (polymorphic `ownerId`, no FK)
- **Root cause:** `resolveConnectionForWebsite` queries `{ownerType, ownerId, status}` with **no `organizationId`** filter, newest first. Connect never validates `ownerId` belongs to the caller's org or that the caller manages it; callback trusts state.
- **Scenario:** Org A TEAM_ADMIN starts OAuth with `ownerId=<Org B team>`; a connection row (Org A) binds to Org B's team id. Org B's syncs may resolve Org A's connection (newest wins) → Org B dashboards read Org A's Google data; or syncs break (availability). Direct read of Org B data is not possible through this alone (mapping still needs website access) — High, not Critical.
- **Fix:** Add `organizationId` to resolution queries; validate owner via `assertTeamAccess`/`assertWebsiteAccess` at connect and re-validate at callback; typed FKs for owner (DB-1 migration program).
- **Tests:** resolution never crosses org; connect with foreign ownerId → 404; callback with revoked membership → rejected.

#### API-4 / DB-4 — Transfer state machine broken (Medium/High)

- **Files:** `websites/[id]/transfer/route.ts:24-40`; `schema.prisma` (`Website.status` vs `WebsiteTransfer.status`)
- **Root cause:** One transaction creates transfer `INITIATED`, moves `teamId`, deletes all assignments, marks `TRANSFERRED`. No destination acceptance; `COMPLETED`/`PENDING_CONNECTION`/`CANCELLED` never set; `website.status` stuck at `TRANSFER_PENDING` forever; `completedAt` never set; no duplicate-transfer guard; integrations untouched (old team's mappings stay live).
- **Fix:** Single authoritative state machine (initiate → pending acceptance → verify destination connection → complete/cancel/expire); move `teamId` at completion; partial unique index blocking duplicate open transfers; clear/re-verify integrations at handover.
- **Tests:** full lifecycle; duplicate → 409; no `teamId` change before acceptance; status consistent at every step.

#### API-5 — Member management protections missing (Medium)

`teams/[id]/members/route.ts:24-32`: re-adding an admin without `isAdmin` silently demotes; removing/demoting the last admin or oneself is allowed → team lockout. Fix: last-admin guard; only change `isAdmin` when explicitly provided.

#### API-6 — TEAM_MEMBER list over-exposure (Medium)

`tenant.ts:37-56`: list endpoints include all team websites for members; detail requires assignment. Members enumerate names/domains/providers of sites they cannot open. Fix: align list with detail policy.

#### API-7 / OAUTH-9 / DB-3 / DB-7 / DATA-5 — Mapping integrity (High)

- **Files:** `properties/map/route.ts:15-32`; `packages/shared/src/validation.ts:35-41`; `packages/google/src/client.ts:44-55`; `schema.prisma:316-341`
- **Root cause:** Map accepts any `externalId` string; never verified against discovered properties; `googleConnectionId`/`googlePropertyId` FK columns exist but are **never written**; sync resolves credentials independently (website→team, newest first) so data can come from a different Google account than the mapped property's. Nothing prevents multiple `isPrimary` rows per (website, provider); "primary" is decided by `updatedAt` tiebreak.
- **Fix:** Require `connectionId` + discovered-property id; verify ownership; persist FKs; sync uses the mapping's connection; single-primary via partial unique index `WHERE isPrimary` + transactional demote-others.
- **Tests:** undiscovered externalId → 400; mapping stores connection; second primary demotes first; reconnect doesn't silently switch accounts.

#### API-8 — No API rate limiting; sync abusable (Medium)

`rateLimit()` is only called from `auth/login`. `POST /api/sync` needs only `analytics.view` (TEAM_MEMBER) and writes an `AnalyticsSyncJob` row per call even when BullMQ dedupes → unbounded row spam + Google quota burn. Fix: Redis limits per user/org/connection; manage-level permission for manual sync; skip row creation when deduped.

#### API-9 — Error contract (Low)

No try/catch in most routes → Prisma FK/unique violations become opaque 500s; `discover` returns raw `e.message`; analytics handler returns provider error text in `details`. Fix: central error mapper (P2002→409, P2003→400, P2025→404), stable error codes, server-side detail logging with correlation id.

#### API-10 / DATA-11 — CSV injection (Low/Medium)

`analytics/pages/route.ts:11-16`: `Object.values(r).join(",")` — no quoting; GA4 page paths starting with `= + - @` become spreadsheet formulas. Fix: proper CSV writer + neutralize leading dangerous chars.

#### API-11 — Client-settable lifecycle status (Low)

`validation.ts:19`: create/PATCH accept `TRANSFER_PENDING`/`SOLD`, bypassing the transfer workflow. Fix: server-managed statuses only.

#### API-12 — Pagination (Low)

`teams`/`connections` lists unbounded; `websites` silently truncates at `take: 100`. Fix: cursor pagination (default 50, max 200).

**Verified NOT PRESENT in this area:** `websites/[id]` IDOR (asserts run before fetch); analytics `websiteId` unverified (handler asserts access); token fields in connection responses (explicit `select`); cross-org member adds (target org-checked).

### 4.3 Google OAuth, encryption, mapping

#### OAUTH-1 — State replayable (High)

`packages/google/src/oauth.ts:16-40`: nonce is generated and embedded but never stored/consumed (doc comment claims "single-use" — false). Within the 10-minute window one state pairs with multiple codes. Fix: persisted state records (nonce hash, userId, owner, expiry), atomic one-time consumption. Tests: replay rejected; concurrent callbacks — one wins.

#### OAUTH-2 — Callback unauthenticated, no session binding (High)

`oauth/callback/route.ts:7-68`: never calls session auth; identity comes solely from state `userId`. A leaked state+code is usable from any browser. Fix: bind state to the initiating session; require matching authenticated session at callback.

#### OAUTH-3 — Non-constant-time compare (Low)

`oauth.ts:31` uses `!==` on hex HMAC. Fix: `crypto.timingSafeEqual` with length check.

#### OAUTH-5 — No PKCE (Medium)

`oauth.ts:54-66`: no `code_challenge`; `getToken` passes no verifier. googleapis supports it. Fix: S256 PKCE, verifier stored with the persisted state record (OAUTH-1).

#### OAUTH-7 — Encryption: sound core, no rotation (Medium)

`packages/shared/src/crypto.ts:4-28`: AES-256-GCM, fresh 12-byte IV per op, 32-byte env key, fail-closed — **PASS**. Gaps: no key-id/version in envelope, so rotating `GOOGLE_TOKEN_ENCRYPTION_KEY` breaks every stored credential at once; no AAD. No token logging or client exposure found. Fix: versioned envelope `v1:<keyId>:…`, decrypt-with-old + re-encrypt-on-use lazy migration, AAD = connectionId. Tests: old-key ciphertext decrypts post-rotation.

#### OAUTH-8 / OPS-8 — Token refresh races (Medium/High)

`packages/google/src/tokens.ts:6-43`: read-check-refresh-update with no lock/CAS. Concurrent refreshes can overwrite a rotated refresh token with a stale one (permanent breakage); **any** error (incl. transient 5xx/network) flips status to `NEEDS_REAUTH`; `invalid_grant` detection regexes `err.message` only (googleapis carries it in `err.response.data.error`). Fix: per-connection Redis lock + double-checked expiry; only structured `invalid_grant` marks REVOKED; transient errors leave status unchanged. Tests: 10 concurrent refreshes → 1 provider call; network error → status unchanged.

#### OAUTH-10 — Redirect URI fixed from env (PASS)

`oauth.ts:8-13` throws if unset; same client factory everywhere; no request-derived URI. Minor: callback post-auth redirect falls back to `http://localhost:3000` when `NEXT_PUBLIC_APP_URL` unset (UX bug).

#### OAUTH-12 — Minor (Low)

Raw `e.message` returned by discover; no rate limiting on OAuth initiation/callback; `revokeConnection` writes literal `"revoked"` into `encryptedRefreshToken` (latent footgun).

### 4.4 Database & data integrity

#### DB-5 — Seed known-password SUPER_ADMIN (High — immediate ops action)

`packages/db/src/seed.ts`: idempotent upsert creates `demo@example.com` / `ChangeMe123!`, `SUPER_ADMIN`, `emailVerified: true`; no `NODE_ENV` guard; password printed to stdout. The repo is public and the seed has been run against the real database, so this account plausibly exists in production data today. **Fix:** refuse in production unless `SEED_DEMO_ADMIN_PASSWORD` env set; never print it. **Ops:** verify whether the account exists in prod; disable/rotate it.

#### DB-6 — Orphaned connections (Medium)

Polymorphic owner means deleting a team/website leaves connection rows (with encrypted refresh tokens) orphaned forever. No delete APIs exist today (latent). Fixed by DB-1's typed FKs; interim orphan-scan report.

#### DB-8 — Index gaps (Medium)

Resolution query `{ownerType, ownerId, status}` can't use the org-leading index; scheduler's `{status, tokenExpiresAt}` expiry scan unindexed; `AnalyticsSyncJob` groupBy lacks `updatedAt` in index; `mappingStatus` unindexed. Fix: additive indexes `(status, tokenExpiresAt)`, `(websiteId, type, status, updatedAt)`, partial `WHERE mappingStatus='MAPPED'`; org-scope the resolution query (DB-1).

#### DB-9 / DATA-4 — Unbounded lists + wrong connected count (Medium)

Server pages fetch full org collections without pagination; `dashboard/page.tsx:33` computes `websites.filter(w => integrations.some(i => i.mappingStatus === "MAPPED"))` — callback ignores `w`, so one mapped integration marks every website "connected" (query doesn't even select `websiteId`). Fix: cursor pagination; per-website counts via `groupBy`/where-some.

#### DB-10 — Audit log partial (Medium)

Model + helper solid; covered: website/team/connection/map/transfer/sync mutations. Missing: all auth events, role changes, token revocation by worker, exports. `ipAddress` never populated; no request/correlation id; `details` scrubbing is a comment, not enforced; org Cascade destroys the audit trail with the tenant. Fix: wire better-auth events + worker paths; populate ip; add `requestId` column; Restrict/archive on org delete.

#### DB-11 — Discovery N+1 writes (Low)

Sequential `await` upsert per discovered property (tens–hundreds of round trips). Fix: `createMany({skipDuplicates})` + targeted updates.

#### DB-12 — Over-fetching token columns (Low)

`(app)/integrations/page.tsx` loads full connection rows incl. encrypted tokens into the RSC (not serialized to client today). Fix: explicit `select` everywhere; consider global omit.

#### DB-13 — Redundant indexes (Low)

`Organization.slug` has both `@unique` and `@@index`; `GoogleProperty(connectionId)` redundant with the unique's leading column. Drop in a cleanup migration.

#### DB-14 — No retention (Low)

`IntegrationHealth`/`AnalyticsSyncJob` grow forever (~2,880 rows/day/website at realtime cadence if recorded per run); `AnalyticsCache.expiresAt` has no purge job. Fix: retention jobs (health 90d, jobs 180d, cache purge hourly); soft-delete only where product needs it.

#### DB-15 — Single-org-per-user design (Medium)

`User.organizationId` non-nullable + global `User.role` + `TeamMember.isAdmin` = two overlapping signals; multi-org users (agencies/flippers — the target market) impossible; org-level Owner/Admin roles inexpressible. Fix: `OrganizationMembership(userId, organizationId, role)`; `User.role` kept only for platform SUPER_ADMIN. Migration: create + backfill + dual-read, drop later.

#### DB-16 — Schema hygiene (Low)

`IntegrationHealth.status` free string vs enums elsewhere; `Verification` lacks `(identifier, expiresAt)` composite; better-auth `Account` stores OAuth tokens in plaintext columns (library standard; GoogleConnection tokens are encrypted — note only).

**Verified NOT PRESENT:** duplicate team memberships / website assignments (unique keys + upserts present).

### 4.5 Worker, queues, cache, rate limiting

#### OPS-2 — Realtime capacity ceiling (Critical)

- **Files:** `apps/worker/src/scheduler.ts:17` (60s tick); `packages/jobs/src/scheduler.ts:5,72-89` (30s interval, no stagger/backpressure); `apps/worker/src/index.ts:82-92,120` (limiter 20/min, concurrency 5); `packages/google/src/sync.ts:142` (30s TTL)
- **Math:** every GA4-mapped website is due every tick → 1 job/site/min produced vs 20/min processed (Redis-global limiter — replicas don't raise it). Breakeven = **20 websites**. At 100 sites: +80/min backlog ≈ 115k jobs/day; jobs run so late their 30s-TTL cache writes expire unread; Redis grows to eviction/OOM. Cold start: one tick enqueues ~600 jobs (6 queues × 100 sites), no jitter. Other queues are fine at 100 sites (historical ~2.2/min, SC ~0.2/min, Ads ~0.55/min, health ~1.7/min).
- **Fix:** coalesce per-website realtime jobs (one pending, replace-on-enqueue); stagger by websiteId hash; adaptive interval (30s only for sites with active dashboard sessions, 2–5 min otherwise); queue-depth backpressure; raise limiter only against measured per-connection quota budgets.
- **Tests:** load test at 100/500 simulated sites (produced vs processed, lag); coalescing test; backpressure test. _Not live-tested — arithmetic from code constants._

#### OPS-1 — In-memory rate limiter (High)

`packages/shared/src/rate-limit.ts:1-12`: per-process Map, entries never deleted (unbounded growth), fixed window mislabeled "sliding", comment claims Redis limiting exists (it doesn't). Used for login (per-instance on serverless → bypassable) and per-connection Google guard (multiplied by replicas → quota burn). Fix: Redis atomic limiter (Lua/INCR+EXPIRE or sorted-set sliding window), per-policy keys (IP+email, connection, org); cover signup/reset/OAuth too.

#### OPS-3 — Non-idempotent job bookkeeping (High)

`packages/db/src/health.ts:10` always inserts; worker creates a new `AnalyticsSyncJob` row per attempt (5 attempts → 5 rows); `externalId` has no unique constraint; manual-sync route creates a `PENDING` row the worker never updates (permanent orphans); no retention. Fix: upsert by `externalId` (unique); current-state health upsert + optional event log; retention job; manual route passes its row id to the worker.

#### OPS-4 — No dead-letter handling (High)

`packages/jobs/src/queue.ts:56-59`: after 5 attempts jobs are dropped (`removeOnFail: 100`); only trace is a console line + FAILED row. No DLQ, alerts, metrics, correlation IDs. A revoked grant silently stops syncing a website forever. Fix: DLQ (or failed-jobs table with payload+error), structured logs/metrics + alert thresholds, correlation IDs, admin requeue path.

#### OPS-5 — No graceful shutdown (Medium)

No SIGTERM/SIGINT handlers anywhere; process chain pnpm→cross-env→tsx→node doesn't forward signals → SIGKILL mid-job → stalled redelivery + duplicate side effects (compounds OPS-3). Fix: signal handlers closing workers/queues/Redis/Prisma; node as PID 1 (exec-form CMD).

#### OPS-6 / DATA-12 — Cache defects (High/Medium)

`packages/shared/src/cache.ts:22-40,56,64,74`: keys **are** tenant-scoped (org+website+property+source+report+range+filters — no cross-tenant collision; PASS). Defects: invalidation uses Redis `KEYS` (O(N) blocking, called from 5 routes, same Redis as BullMQ); no single-flight (N concurrent cold requests → N Google calls; errors not negative-cached); "stale-while-revalidate" never serves stale — on error returns 429/502 despite holding a stale value. Fix: SCAN or versioned namespaces; per-key single-flight; serve stale + freshness flag on provider error; short negative-cache TTL.

#### OPS-7 — Scheduler lock never released/renewed (Medium)

`apps/worker/src/scheduler.ts:17-24`: `SET PX 55000 NX` acquired, never DELeted/extended; token uses `pid` (=1 in every container). Ticks >55s (plausible at scale, OPS-11) interleave across instances — mitigated by bucketed jobId dedup (no duplicate jobs, just wasted work). Fix: Lua compare-and-delete release; TTL renewal; `addBulk` + paginated queries; in-process running flag.

#### OPS-9 — Worker Dockerfile (Medium)

Non-root `USER node` ✅; single-stage `COPY . .` + full install (devDeps needed for tsx runtime) → large image with web app/docs/tests; floating `node:26-slim` tag; no HEALTHCHECK; no HTTP health endpoint (hung-but-alive worker undetectable). Fix: multi-stage/pruned build, digest-pinned base, `/healthz` + readiness (Redis+DB ping), Docker HEALTHCHECK.

#### OPS-10 — Shared ioredis connection for all BullMQ workers (High)

`packages/shared/src/cache.ts:10` (`maxRetriesPerRequest: 1, enableReadyCheck: false`) + `packages/jobs/src/queue.ts:41-46` + `apps/worker/src/index.ts:119-120`: one socket serves 9 Workers + Queues + cache + scheduler lock. BullMQ requires `maxRetriesPerRequest: null` and dedicated connections (blocking pops serialize on a shared socket). Fix: pass connection options to BullMQ (dedicated connections per Worker), `maxRetriesPerRequest: null`, separate cache client.

#### OPS-11 — Scheduler tick cost unbounded (Medium)

`apps/worker/src/scheduler.ts:26-34`: every 60s reads all mapped websites + `groupBy` over **all** SUCCEEDED job rows ever (no time window); sequential `await enqueue` per job. Tick latency scales with total history → feeds OPS-7. Fix: per-(website,type) last-success summary table or windowed query; paginate; `addBulk`; retention (OPS-3).

#### OPS-12 — Dead config / silent no-ops (Low)

`ga4DailyMinutes` defined, never used; `getQueue` returns null without Redis → enqueue silently no-ops; manual sync claims "queued in DB only" but no DB poller exists. Fix: remove/wire dead config; make enqueue failures explicit (503).

### 4.6 Analytics correctness

#### DATA-1 — GA4 realtime double-count (High)

`packages/google/src/ga4.ts:35-47`: realtime report requests 7 dimensions, then `rows.reduce(sum)` for the total — one user on 3 pages counts 3×. Breakdowns (`by(dimIdx)`) inflated the same way. Fix: separate dimension-less query for the true total; per-dimension queries for breakdowns. Test: fixture with 1 user × 3 page rows → total = provider total.

#### DATA-2 — Search Console position unweighted (High)

`search-console.ts:32`: `Σposition / rows.length` instead of `Σ(position×impressions)/Σimpressions`. (CTR at `:31` is correctly weighted — that part of the claim is NOT PRESENT.) Fix: impression-weighted; `null` when impressions = 0.

#### DATA-3 — Search Console totals truncated (High)

`search-console.ts:22,25,28-30`: `rowLimit = 1000`, no `startRow` pagination; totals reduced from the returned page only (sorted by clicks desc) → clicks/impressions undercounted for almost any real site over 28 days. Fix: separate totals query (no query/page dimensions); paginate details; surface truncation.

#### DATA-6 — Portfolio aggregation absent (Medium)

`analytics-handler.ts:52-68`: without `websiteId` returns counts + `aggregate_requires_per_website_call` — an honest stub; no metric summing exists. Fix: per-website fan-out over cached data with partial-failure reporting, or explicitly descope in docs.

#### DATA-7 — Sampling/thresholding ignored (Medium)

`ga4.ts:88-113` reads only rows/totals; response `metadata` never inspected → sampled numbers presented as exact. Fix: propagate sampling/threshold flags into the envelope + UI caveat.

#### DATA-8 — Missing totals default to 0 (Low)

`ga4.ts:103-107`: no `metricAggregations: ["TOTAL"]` requested; absent totals indistinguishable from zero traffic. Fix: request TOTAL; return `null` when missing.

#### DATA-9 — Ad Manager/AdSense unfinished (Medium)

`ad-manager.ts:30-56` returns the raw report verbatim ("verify the shape against your network"); AdSense card renders only note + row count (earnings fetched correctly at `adsense.ts:50-51` but never displayed). Fix: typed parsers; render AdSense totals; verify against a real account before claiming support.

#### DATA-10 — Freshness mislabel (Low)

`analytics-handler.ts:131`: freshly refetched data labeled `"stale-while-revalidate"`. Fix: true SWR or relabel `"live"` (see OPS-6).

**Verified NOT PRESENT:** fake/hardcoded analytics anywhere in components; GA4 historical summary uses provider totals when present; AdSense totals from provider response; cache keys org-scoped and unit-tested.

### 4.7 Frontend & UX

#### FE-1 — No route boundaries (Medium)

Zero `loading.tsx`/`error.tsx`/`not-found.tsx`; `Skeleton` component defined, never used. Prisma/Google failures → Next default error page. Fix: per-route loading (Skeleton) + error with retry + not-found.

#### FE-2 — "Source: undefined" on API errors (Medium)

`WebsiteAnalytics.tsx:5-8,41-60`: `fetchJson` doesn't check `r.ok`; `isError` never checked; a 502 renders `Source: undefined · Freshness: undefined`. Fix: check `r.ok`; per-card error state with retry.

#### FE-3 — Accessibility (Medium)

Login inputs placeholder-only (no labels); app-wide: 1 `aria-label`, 0 `<label>`, 0 focus styles, 0 `role=`; no `aria-current`; charts have no text alternative; table `<th>` without `scope`. Positives: logo `alt` text, `<html lang>`. Fix: labels, focus-visible rings, aria-current/live, hidden data tables; axe smoke test.

#### FE-4 — Freshness indicators dropped (Low)

Envelope carries source/freshness/lastSyncedAt; most cards don't render it in the ok state; dashboard shows no sync info. Fix: render StatusNote everywhere; per-website last-sync on dashboard.

#### FE-5 — Raw metric keys in UI (Low)

`WebsiteAnalytics.tsx:112-120,143-162` renders `totalUsers`, `sessionConversionRate` verbatim (first 8 only); AdSense shows "{n} rows returned". Fix: label/format map (percent/duration/currency).

#### FE-6 — Hardcoded domain in metadata (Low)

`layout.tsx:8,19`: `metadataBase` = `https://metricflock.com` regardless of `NEXT_PUBLIC_APP_URL`. Fix: derive from env.

### 4.8 CI, testing, docs, env

#### CI-2 — No security headers (Medium)

No `headers()` in `next.config.ts`, no middleware: no CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy in code (platform defaults only). Fix: `headers()` with Next/Recharts-compatible CSP; assert in smoke test.

#### CI-3 — Lint vacuous for TypeScript (Medium)

`eslint.config.mjs` documents that typescript-eslint doesn't support TS 7.0 → `.ts/.tsx` unlinted; package-boundary rules dormant. CI "Lint" is green while checking ~nothing. Fix: track upstream support; interim grep-based boundary check in CI.

#### CI-4 — Supply-chain gates absent (Medium)

Actions tag-pinned (`@v4`), no Dependabot, no CodeQL, no secret scanning, no `pnpm audit`. Fix: SHA-pin actions; Dependabot (npm+actions); CodeQL; gitleaks; `pnpm audit --prod` gate.

#### CI-5 — CI gaps (Low)

No `format:check` step (root `check` script includes it; CI doesn't run it); coverage script exists, never run, no thresholds.

#### CI-6 — Integration tests don't exist (Medium)

`tests/integration/` is README-only (manual real-account procedure) while `tenant-isolation.test.ts` comments claim DB-backed coverage. All 48 tests are unit-level; zero route-level IDOR tests; no Playwright. Positive: CI smoke test runs against real Postgres 16 + Redis 7 over HTTP. Fix: DB-backed authz/IDOR matrix suite in CI using the existing service containers.

#### CI-7 — `minimumReleaseAge: 0` (Low)

`pnpm-workspace.yaml:25-28` — rationale cites wrangler/miniflare, removed 2026-11-20; stale. Fix: restore 1440 or a narrow documented exception.

#### CI-8 — Docs gaps + staleness (Medium)

Present: 20 docs incl. 6 ADRs. Missing: `docs/audits|security|operations|testing|product/`, `SECURITY.md`, API reference, analytics-calculation rules. README still documents removed Cloudflare scripts and claims "Production-ready" while stating no live Google account was ever verified; `IMPLEMENTATION_PLAN.md` describes the pre-monorepo layout; `SYNC_HEALTH_CHECK_HOURS` read in code but absent from `.env.example`/docs.

#### CI-9 — Husky pre-commit (Low)

Runs `pnpm typecheck` only. Fix: lint-staged (prettier + eslint on staged files).

---

## 5. Brief claims — verification results

Every "previously identified" issue in the brief was checked against current code:

| Brief claim                                         | Verdict                                                                                          | Finding    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| better-auth `role`/`organizationId` mass assignment | **CONFIRMED**                                                                                    | AUTH-1/2/3 |
| Hook trusts client `organizationId`                 | **CONFIRMED**                                                                                    | AUTH-3     |
| OAuth state: no persisted one-time nonce            | **CONFIRMED**                                                                                    | OAUTH-1    |
| State not session-bound; userId trusted from state  | **CONFIRMED**                                                                                    | OAUTH-2    |
| Missing owner permission checks (connect/callback)  | **CONFIRMED** (neither validates)                                                                | OAUTH-6    |
| Weak fallback secrets                               | **CONFIRMED**                                                                                    | OAUTH-4    |
| Non-constant-time signature comparison              | **CONFIRMED**                                                                                    | OAUTH-3    |
| No PKCE                                             | **CONFIRMED**                                                                                    | OAUTH-5    |
| Redirect URI from request                           | **NOT PRESENT** — fixed from env, throws if unset                                                | OAUTH-10   |
| Org-wide connections API privacy                    | **CONFIRMED** (visibility); token leak **NOT PRESENT**                                           | API-3      |
| Encryption: IV/key handling                         | **PASS** core; no rotation                                                                       | OAUTH-7    |
| Website team ownership validation missing           | **CONFIRMED**                                                                                    | API-1      |
| Mapping doesn't persist connection                  | **CONFIRMED** (columns exist, never written)                                                     | OAUTH-9    |
| Realtime active users double-count                  | **CONFIRMED**                                                                                    | DATA-1     |
| SC average position/CTR simple means                | **PARTIAL** — position yes; CTR correctly weighted                                               | DATA-2     |
| Connected-site count assumes all connected          | **CONFIRMED**                                                                                    | DATA-4     |
| TRANSFERRED/TRANSFER_PENDING state conflict         | **CONFIRMED**                                                                                    | DB-4       |
| In-memory Map rate limiting                         | **CONFIRMED**                                                                                    | OPS-1      |
| 30s realtime vs ~20/min limiter mismatch            | **CONFIRMED** (100/min produced at 100 sites — 60s tick caps it below the brief's ~200 estimate) | OPS-2      |
| Jobs not idempotent                                 | **CONFIRMED**                                                                                    | OPS-3      |
| Concurrent token refresh                            | **CONFIRMED**                                                                                    | OAUTH-8    |
| Redis `KEYS` in production paths                    | **CONFIRMED**                                                                                    | OPS-6      |
| Fake/hardcoded analytics                            | **NOT PRESENT** — none anywhere                                                                  | DATA notes |
| `websites/[id]` IDOR                                | **NOT PRESENT** — asserts precede fetch                                                          | API notes  |
| Analytics `websiteId` unverified                    | **NOT PRESENT** — handler asserts access                                                         | API notes  |
| Duplicate team memberships/assignments              | **NOT PRESENT** — unique keys present                                                            | DB notes   |

---

## 6. Recommended implementation sequence

Mapped to the brief's stages (§19). Each stage ends with: tests → typecheck → lint → integration tests → diff review → docs → commit on `security-hardening/production-readiness`. **No stage proceeds past a critical failure without owner approval.**

### Stage 0 — Audit ✅ (this document)

Gate: findings documented. **Owner approval required before Stage 1.**

### Stage 1 — Critical authentication & tenant security (brief Phase 1)

Findings: AUTH-1/2/3 (one change closes all three), AUTH-4/5 (fail-closed secrets + startup env validation), AUTH-9 (email verification + linking guard — needs mailer decision), OAUTH-6/API-1/API-2 app-level owner validation + org-scoped resolution queries, AUTH-7/API-6/API-13 policy alignment, DB-5 seed guard (+ ops check for existing demo account).
Gate: mass-assignment + cross-tenant regression tests pass (new DB-backed suite, CI-6).

### Stage 2 — Database integrity & authorization (brief Phase 2)

Findings: DB-1 typed owner FKs (additive migration program), DB-2 composite FKs, DB-3 single-primary partial index, DB-7 mapping FK backfill, DB-8 indexes, DB-13 drop redundant indexes, DB-15 OrganizationMembership (needs product decision on multi-org), AUTH-8/API-3 connection visibility scoping, API-5 last-admin guard, API-11 server-managed statuses.
Gate: cross-tenant tests pass; migrations reviewed with rollback notes; **no destructive migration without explicit approval.**

### Stage 3 — OAuth & Google connection security (brief Phase 1 §3.5/3.7 remainder)

Findings: OAUTH-1+2+5 (persisted, session-bound, PKCE state records — one coherent change + `OAuthState` table), OAUTH-3 timing-safe compare, OAUTH-7 versioned encryption envelope + rotation runbook, OAUTH-8 refresh locking, OAUTH-12 error hygiene.
Gate: OAuth test matrix passes (expired/replayed/forged/wrong-session/wrong-org/wrong-website).

### Stage 4 — Analytics correctness (brief Phase 3)

Findings: DATA-1 (dimension-less realtime total), DATA-2 (weighted position), DATA-3 (totals query + pagination), DATA-5/OAUTH-9 (bind mapping→connection in fetch path; depends on Stage 2 backfill), DATA-4/DB-9 (connected count + pagination), DATA-7 (sampling flags), DATA-8 (null totals), DATA-9 (Ad Manager parser + AdSense rendering), DATA-6 (portfolio aggregation — product scope decision).
Gate: calculation tests pass; **live Google verification still requires the owner's real account** (separate manual checklist).

### Stage 5 — Queue, Redis, performance (brief Phases 5/6)

Findings: OPS-2 (coalescing/stagger/backpressure), OPS-10 (BullMQ connections), OPS-1 (Redis rate limiter + API-8 coverage), OPS-3 (idempotent bookkeeping + retention DB-14), OPS-4 (DLQ + correlation IDs), OPS-6 (SCAN invalidation, single-flight, true SWR + DATA-10), OPS-7/11 (lock release, tick cost), OPS-5 (graceful shutdown), OPS-9 (Dockerfile/health), DB-11 (discovery batching), API-12 (pagination).
Gate: reliability tests pass; load test at 100/500 simulated websites recorded (not fabricated).

### Stage 6 — API & frontend refinement (brief Phases 7/11)

Findings: API-9 error contract, API-10/DATA-11 CSV safety, FE-1 boundaries, FE-2 error states, FE-3 accessibility, FE-4/5 freshness + metric labels, FE-6 metadata env, CI-2 security headers.
Gate: regression tests pass; axe smoke clean on login/dashboard.

### Stage 7 — Product expansion (brief Phases 4/8/9/10)

Transfer state machine (API-4/DB-4 — needs product decision on acceptance flow), account security (AUTH-10 reset, AUTH-11 sessions, AUTH-12 password policy, MFA/passkeys), audit-log completion (DB-10), then feature work: advanced dashboards, SEO intelligence, revenue analytics, reports/exports, alerts, monitoring, portfolio management, public API. Each feature incrementally, only on verified provider capabilities.
Gate: feature acceptance tests per increment.

### Stage 8 — Observability & operations (brief Phase 13)

Structured logging, request/correlation IDs, metrics (queue lag, provider errors, cache hit rate, sync success), health endpoints (liveness/readiness/db/redis/worker), alerting, backup/restore runbook + tested restore.
Gate: health + recovery tests pass.

### Stage 9 — CI/CD & documentation (brief Phases 14/15)

CI-3 (lint when upstream supports TS7; interim boundary check), CI-4 (SHA pins, Dependabot, CodeQL, secret scan, audit gate), CI-5 (format:check + coverage), CI-7 (`minimumReleaseAge`), CI-9 (lint-staged), CI-8 (missing docs: `docs/security/`, `docs/operations/`, `docs/testing/`, `docs/product/`, `SECURITY.md`; refresh README/plan), the remaining §21 deliverables.
Gate: release checklist passes.

---

## 7. Files likely to change (by stage)

- **Stage 1:** `packages/auth/src/server.ts`, `packages/auth/src/tenant.ts`, `packages/shared/src/crypto.ts`, `packages/shared/src/env.ts`, `apps/web/src/app/api/google/oauth/connect/route.ts`, `apps/web/src/app/api/google/oauth/callback/route.ts`, `packages/google/src/client.ts`, `apps/web/src/app/api/websites/route.ts`, `apps/web/src/app/api/websites/[id]/route.ts`, `packages/db/src/seed.ts`, new `apps/web/instrumentation.ts`, new DB-backed tests under `apps/web/tests/integration/`.
- **Stage 2:** `packages/db/prisma/schema.prisma` + new migrations, `packages/google/src/client.ts`, `apps/web/src/app/api/google/properties/map/route.ts`, `apps/web/src/app/api/google/connections/**`, `apps/web/src/app/api/teams/[id]/members/route.ts`, `packages/shared/src/validation.ts`.
- **Stage 3:** `packages/google/src/oauth.ts`, `packages/google/src/tokens.ts`, `packages/shared/src/crypto.ts`, `schema.prisma` (OAuthState), `apps/web/src/app/api/google/oauth/**`.
- **Stage 4:** `packages/google/src/{ga4,search-console,adsense,ad-manager,client,sync}.ts`, `apps/web/src/lib/analytics-handler.ts`, `apps/web/src/app/(app)/dashboard/page.tsx`, `apps/web/src/components/WebsiteAnalytics.tsx`.
- **Stage 5:** `apps/worker/src/{index,scheduler}.ts`, `packages/jobs/src/{queue,scheduler}.ts`, `packages/shared/src/{rate-limit,cache}.ts`, `packages/google/src/sync.ts`, `packages/db/src/health.ts`, `apps/worker/Dockerfile`, `schema.prisma` (job externalId unique, summary table).
- **Stage 6:** `apps/web/next.config.ts`, `apps/web/src/app/**` (loading/error/not-found), `apps/web/src/components/**`, `apps/web/src/app/api/analytics/pages/route.ts`, shared error mapper in `apps/web/src/lib/`.
- **Stages 7–9:** transfer route + schema, auth server config, audit call sites, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `docs/**`, `README.md`, `.husky/pre-commit`, `pnpm-workspace.yaml`.

---

## 8. Database migration risks

| Change                                                                                           | Risk                                                                 | Mitigation                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB-1 typed owner FKs (add `teamId`/`websiteId`, backfill, CHECK, drop `ownerType/ownerId` later) | Orphaned rows whose `ownerId` resolves to nothing; dual-write window | Additive first; backfill where target exists; quarantine orphans to a report; drop old columns only in a later release. Rollback: additive until final drop. |
| DB-2 composite FKs (`@@unique([id, organizationId])` + composite relations)                      | Pre-existing cross-org rows (created via API-1) will violate the FK  | Pre-flight violation query; fix/quarantine rows before adding FKs. Rollback: drop FKs; uniques harmless.                                                     |
| DB-3 partial unique index `WHERE isPrimary`                                                      | Existing duplicate primaries block index creation                    | Pre-flight dedupe (keep newest, demote rest) before index. Rollback: drop index.                                                                             |
| DB-15 OrganizationMembership                                                                     | Largest change; every authz query touches org membership             | Create + backfill + dual-read period; drop `User.organizationId/role` only after cutover verified. Rollback: reversible until column drop.                   |
| DB-4 transfer states                                                                             | Websites stuck in `TRANSFER_PENDING` with `TRANSFERRED` records      | Backfill: `TRANSFERRED` → website `ACTIVE`; new enum values additive.                                                                                        |
| Stage 3 `OAuthState` table                                                                       | None (new table)                                                     | Additive.                                                                                                                                                    |
| OPS-3 `externalId` unique on AnalyticsSyncJob                                                    | Existing duplicate rows                                              | Dedupe pre-flight; or add unique on new column.                                                                                                              |
| DB-8/DB-13 index adds/drops                                                                      | Low (brief lock on index build; small tables today)                  | `CREATE INDEX CONCURRENTLY` via raw SQL if tables grow.                                                                                                      |
| DB-10 `requestId` column                                                                         | None                                                                 | Additive nullable.                                                                                                                                           |

**Rule honoured throughout:** no destructive migration executes without explicit owner approval; every schema change ships with a reviewed migration + rollback note.

---

## 9. Required environment variables & test infrastructure

**Already defined (`.env.example`):** `DATABASE_URL`, `REDIS_URL`, `NEXT_PUBLIC_APP_URL`, `SESSION_SECRET` (≥32), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (32-byte base64/hex), `GOOGLE_*_ENABLED` flags, `SYNC_*` intervals. **Undocumented but read in code:** `SYNC_HEALTH_CHECK_HOURS` (CI-8).

**Needed by upcoming stages:**

- Stage 1: a transactional mailer (SMTP/API key) for email verification (AUTH-9) — **owner decision required** (provider choice); optionally `OAUTH_STATE_SECRET` (else derive from `SESSION_SECRET`).
- Stage 3: optional `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` for rotation window (OAUTH-7).
- Stage 8: error-monitoring DSN (optional, owner decision).

**Test infrastructure:**

- CI already provides Postgres 16 + Redis 7 service containers (smoke test) — sufficient for the new DB-backed integration suite (Stage 1 gate).
- Sandbox limitation: Prisma engine binaries cannot download through the sandbox egress proxy; local verification uses cached engines. CI has normal network.
- Live Google verification (Stage 4 gate) requires the owner to connect a real Google account — cannot be done by the agent.
- Load tests (Stage 5) need a disposable Redis/Postgres and simulated website fixtures; results must be measured, not estimated.

---

## 10. Complexity estimates by phase

T-shirt sizes (S ≈ hours, M ≈ 1–2 days, L ≈ 3–5 days, XL ≈ 1–2 weeks of focused work incl. tests):

| Stage                           | Size                  | Notes                                                              |
| ------------------------------- | --------------------- | ------------------------------------------------------------------ |
| 1 Critical auth/tenant security | **M**                 | Small code changes, large test surface; mailer decision for AUTH-9 |
| 2 DB integrity & authorization  | **L** (XL with DB-15) | Migration program; DB-15 is the long pole — can be deferred        |
| 3 OAuth & connection security   | **M**                 | One coherent state-record change + encryption envelope             |
| 4 Analytics correctness         | **M**                 | Math fixes are small; live verification depends on owner account   |
| 5 Queue/Redis/performance       | **L**                 | OPS-2 redesign + load testing dominates                            |
| 6 API & frontend refinement     | **M**                 | Broad but shallow                                                  |
| 7 Product expansion             | **XL**                | Open-ended; scope per feature with owner                           |
| 8 Observability & operations    | **M**                 | Metrics/health/runbooks                                            |
| 9 CI/CD & documentation         | **S–M**               | Mostly configuration + writing                                     |

---

## 11. What is done well (verified)

- Every API route authenticates; zod validation on all bodies/queries; org scoping always derives from the session user, never client input (except the specific gaps above).
- `getSessionUser` re-reads the user row per request — role/org changes apply immediately.
- Password hashing is better-auth's scrypt; cookie defaults sane (`httpOnly`, `sameSite=lax`, secure on https); DB-backed sessions with server-side revocation.
- AES-256-GCM token encryption with fresh IVs, fail-closed key handling; no token leakage in any API response (`select` excludes token columns); no token logging.
- Cache keys are tenant-scoped and unit-tested; sync engine warms exactly the keys the handler reads; expected-state vs throw error contract in the sync engine.
- Deliberate `onDelete` choices (Restrict on history-bearing FKs, SetNull on audit actor); natural-key uniques on memberships, assignments, properties, integrations; money as `Decimal(12,2)`.
- Bucketed BullMQ jobId dedup; `Worker.RateLimitError()` used correctly; scheduler `groupBy` instead of per-website queries.
- **No fake analytics data anywhere** — unconnected states are explicit end-to-end; GA4 historical summary uses provider totals; AdSense totals from provider; SC CTR correctly weighted.
- CI is real: install/typecheck/lint/unit/build + an HTTP smoke test against real Postgres/Redis, currently green. 48 unit tests pass; build passes.
- Worker Docker image runs as non-root; `.dockerignore` excludes secrets; worker exits 1 without `REDIS_URL`.
- 20 documentation files incl. 6 ADRs; migration history short and honest (the one destructive migration is documented and was pre-production).

---

## 12. Limitations of this audit

- **No live exploitation** was performed; Critical findings are verified by code + library-source inspection (better-auth 1.7.26 `parseInputData` behavior read from installed dist).
- **No live Google account** has ever been connected, so provider response shapes (esp. Ad Manager, DATA-9) and quota behavior are unverified.
- **No load test** was run; OPS-2 capacity numbers are arithmetic from code constants (tick, intervals, limiter, TTLs).
- **No EXPLAIN plans** were run (no live DB in sandbox); DB-8 is based on query shapes vs index definitions.
- **Production data was not inspected** (e.g., whether the DB-5 demo account exists in the real database, whether cross-org rows from API-1 exist) — these need owner-approved read-only checks against the real database.
- **Platform-level controls** (Vercel headers, WAF, database backups by the provider) were out of scope.
- The currently deployed site (metricflock.vercel.app) still serves the pre-monorepo build; this audit covers `main` @ `b2b17d1a`, which is not yet deployed (Vercel daily deployment limit). Fixing Stage 1 before the new build deploys is strongly recommended.

---

_End of Phase 0 audit. Next step: owner review → approval → Stage 1._
