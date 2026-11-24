# Phase 2 — API / Functional Audit (Independent Production-Readiness Audit)

- **Repo:** `~/workspace/metricflock/` (Next.js 16 monorepo). Claimed HEAD `6e6d2b21` could **not** be verified locally (sandbox copy has no `.git`); findings cite file contents as present.
- **Method:** read all 52 `apps/web/src/app/api/**/route.ts` files end-to-end, plus the shared handlers they depend on (`apps/web/src/lib/analytics-handler.ts`, `api-error.ts`, `api-key-auth.ts`, `pagination.ts`, `portfolio.ts`, `health.ts`, `insights.ts`, `transfers.ts`, `analytics-response.ts`, `csv.ts`), `packages/auth/src/api-helpers.ts` / `tenant.ts` / `permissions.ts`, `packages/shared/src/validation.ts` / `rate-limit.ts` / `cache.ts`, `packages/google/src/oauth.ts` / `tokens.ts` / `client.ts` / `discovery.ts` / `sync.ts`, `packages/db/prisma/schema.prisma`, and `scripts/smoke-test.sh` (read only; runs in CI only). Prior audit docs were **not** trusted; every claim was re-derived from current source.
- **Dynamic evidence:** no Postgres/Redis in the sandbox, so **no endpoint was executed live**. Unit suite re-run locally: **38 files / 196 tests, all passing** (see §5). No unit test imports any `route.ts` (verified by grep); there are **no route-level tests** in the repo — `apps/web/tests/integration/` contains only a README, and the Playwright e2e specs (`journeys`, `accessibility`, `app-accessibility`) are UI journeys with no API assertions. The smoke test is the only live route-level coverage and it runs in CI only.
- **Date:** 2026-11-23.

## Finding format

`A-API-NN`, severity **P0** critical · **P1** high · **P2** medium · **P3** low, exact `file:line`, evidence, reproduction (or why NOT RUN), impact, recommended correction, regression-test requirement, verification status **CONFIRMED** (code-read) vs **POTENTIAL** (needs live check). Cross-references to Phase 1 findings (`A-SEC-NN` in `01-SECURITY-AUDIT.md`) are noted where a finding spans both docs.

## Role note

Actual roles are `SUPER_ADMIN / TEAM_ADMIN / TEAM_MEMBER` (`packages/auth/src/permissions.ts:20`). There is no `ADMIN`/`MEMBER` role in code. Permission checks are role-level (`requireApiAuth(permission)`), then tenant checks (`assert*Access`) that additionally require per-team `isAdmin` membership for most writes.

---

## Findings

### A-API-01 — P1 — CONFIRMED — Cross-tenant sync/metrics endpoints (mirror of A-SEC-01)

- **Files:** `apps/web/src/app/api/sync/failed/route.ts:15-17` (count + `findMany` on `{ status: "FAILED" }`, no org filter), `apps/web/src/app/api/sync/requeue/route.ts:20` (`findUnique` by id, no org filter, then `enqueue` + status flip), `apps/web/src/app/api/metrics/route.ts:24-33` (`groupBy` + `findFirst` on `AnalyticsSyncJob`, no org filter).
- **Evidence:** `AnalyticsSyncJob.website` relation exists (`schema.prisma:496-510`) and could scope every query via `website: { organizationId }`; none of the three does. The CI smoke test _does_ exercise the DLQ (`scripts/smoke-test.sh:381` — fixture a FAILED row, list, requeue, confirm it leaves the DLQ) but with a **single org**, so the cross-tenant case is untested at every level.
- **Reproduction: NOT RUN** (no DB). Two orgs, failed jobs in B; SUPER_ADMIN of A calls `GET /api/sync/failed` / `POST /api/sync/requeue { jobId: <B id> }` — code path returns/requeues B's jobs.
- **Dynamic verification 2026-11-23 (retry, real DB + local app server, scratch orgs A/B): CONFIRMED-BY-EXECUTION.** See A-SEC-01 for the full executed evidence: org A's SUPER_ADMIN received org B's FAILED job (with payload) from `GET /api/sync/failed`, saw it counted in `GET /api/metrics`, and `POST /api/sync/requeue` with B's job id reached `enqueue()` (503 `queue_unavailable` only for lack of Redis).
- **Impact:** tenant-isolation breach with write effects (requeue mutates another tenant's queue and writes the audit row under the wrong org). Functional impact: DLQ and metrics are unusable as per-tenant views in any multi-tenant deployment.
- **Correction:** scope all three queries by `website.organizationId` (see A-SEC-01 for exact shape); add a two-org smoke test.
- **Regression test:** smoke test with two orgs: list shows only own jobs; foreign requeue → 404.
- **Status:** CONFIRMED (code). Dynamic NOT RUN. **Dynamic verification 2026-11-23 (retry): CONFIRMED-BY-EXECUTION** (see above).

### A-API-02 — P2 — CONFIRMED — Error contract is inconsistent: 19 of 52 routes bypass `withApiErrors`, and most errors carry no `requestId`

- **Evidence:** `apps/web/src/lib/api-error.ts:63-86` defines the contract — `{ error: <stable_code>, requestId }`, Prisma codes mapped (`P2002`→409 `conflict`, `P2003`→400, `P2025`→404, else 500 `internal_error`). But a grep for files **not** containing `withApiErrors` lists 19 route files: all 9 analytics routes, `google/connections` GET, `teams` GET, `websites` GET, `websites/[id]` GET, `metrics` GET, `sync/failed` GET, `health` + `health/ready` GET, `auth/login`, `auth/logout`, `google/oauth/connect`, `google/oauth/callback`. On those routes an uncaught Prisma/validation error becomes a framework 500 (HTML in production, no stable code, no `requestId`), and even their _handled_ errors are bare `NextResponse.json({ error })` with no `requestId` — unlike `apiError()` responses. The analytics handler (`analytics-handler.ts`) has a try/catch only around the provider `fetchFn`; `resolveConnectionForWebsite` throwing `NOT_FOUND_OR_FORBIDDEN`, or a Prisma throw in `getPrimaryIntegration`, escapes it.
- **Impact:** clients cannot rely on the documented error shape; on-call cannot correlate a user-reported failure to a log line for ~37% of routes (and the analytics routes are the highest-traffic ones). The smoke test asserts `x-request-id` on responses (`smoke-test.sh:368`) — that header comes from `proxy.ts`, not from the error body, so the gap is invisible to it.
- **Correction:** wrap every route handler in `withApiErrors` (or move the wrapper into a shared route factory); make `requireApiAuth` failures and all hand-written error responses go through `apiError()` so `requestId` is always present.
- **Regression test:** smoke test asserting every route's 500 path returns `{ error: "internal_error", requestId }` as JSON (e.g. force a DB failure); unit test that `withApiErrors` is applied (static lint: fail CI if a route file lacks the wrapper).
- **Status:** CONFIRMED (code).

### A-API-03 — P2 — CONFIRMED — Invalid `status` filter on `GET /api/websites` returns 500; invalid `range` silently coerced to 28d

- **Files:** `apps/web/src/app/api/websites/route.ts:13,19` — `status` query param is passed raw into the Prisma `where` (`...(status ? { status } : {})`) with no validation against the `WebsiteStatus` enum. Prisma throws a `PrismaClientValidationError` for an unknown enum value — which has **no `P…` code**, so `prismaErrorResponse` (`api-error.ts:33-36`) returns null and `withApiErrors` falls through to 500 `internal_error`. (And this GET is one of the unwrapped routes per A-API-02, so in practice it is a framework 500, not even the contract 500.)
- **Second half:** `apps/web/src/lib/analytics-response.ts:55-66` (`resolveRange`) — an unknown `range` silently becomes 28 days (`days[range] ?? 28`); `range=custom` without valid dates also falls back to 28d. `format` other than `json|csv` is silently ignored (zod `analyticsQuerySchema` does validate `format` as an enum — so an invalid `format` is a 400 — but `range` is a zod enum too; the silent coercion happens _after_ zod passes because `resolveRange` is also called directly from `v1/portfolio`, `v1/websites/[id]/analytics`, and `reports/send-test` with raw query values).
- **Impact:** a typo'd `?status=ACTIV` is indistinguishable from a server outage to the client; a typo'd `range` silently returns wrong-date data, which is worse than an error for an analytics product.
- **Correction:** validate `status` against the enum (400 `invalid_status`); make `resolveRange` throw/return 400 on unknown ranges at every call site.
- **Regression test:** smoke/unit tests: `GET /api/websites?status=BOGUS` → 400; `GET /api/v1/portfolio?range=bogus` → 400.
- **Status:** CONFIRMED (code). Dynamic NOT RUN.

### A-API-04 — P2 — CONFIRMED — `writeAudit` failure after a successful mutation turns the mutation into a 500

- **Evidence:** nearly every mutating route does `await writeAudit(…)` _after_ the mutation, unguarded — e.g. `apps/web/src/app/api/teams/route.ts` (POST), `apps/web/src/app/api/websites/route.ts` (POST), `apps/web/src/app/api/members/invite/route.ts` (POST), `apps/web/src/app/api/members/[id]/route.ts` (PATCH/DELETE). `writeAudit` (`packages/db/src/audit.ts:33`) is a plain `prisma.auditLog.create` — it throws on any DB error. If it throws, `withApiErrors` returns 500 even though the team/website/invite was already created. (Contrast: auth events use best-effort audit with try/catch, `packages/auth/src/server.ts:11-21` — the pattern exists but was not applied to API routes.) Client retry then hits `domain_taken` / slug `conflict` 409s, or — for invites — silently replaces the previous invite.
- **Impact:** spurious 500s under DB pressure; duplicate-submission confusion; audit becomes a hard dependency of every write, the opposite of its design intent.
- **Correction:** make route-level `writeAudit` best-effort (catch + log, as the auth hook does) or move it into the same transaction as the mutation where atomicity is required.
- **Regression test:** unit test with a mocked failing `writeAudit` asserting the route still returns 201/200.
- **Status:** CONFIRMED (code). Dynamic NOT RUN.

### A-API-05 — P2 — CONFIRMED — No rate limiting on 47 of 52 routes (functional/availability mirror of A-SEC-07)

- **Evidence:** `rateLimit(` call sites in `apps/web/src/app/api`: login, OAuth connect, OAuth callback, invite create — plus the 120/min per-key limit in `requireApiKey` covering the 5 v1 routes. Everything else — all 9 analytics routes (live Google calls), org export/delete, teams/websites/members writes, transfers, sync trigger, discovery, reports/send-test — is unthrottled per user/org. The only throttle on live analytics is the single-flight Redis lock and the worker-side `google:<connectionId>` 30/min limit (`packages/google/src/sync.ts:243`), which does not cover on-demand fetches.
- **Impact:** an authenticated user can burn Google quota and DB capacity at will; a runaway client or a compromised low-privilege account has no brake. `POST /api/sync` + `POST /api/google/properties/discover` are the cheapest quota-burn vectors.
- **Correction:** shared rate-limit wrapper for authenticated routes (per user + route, stricter for analytics/discover/export/sync), fail-closed when Redis is configured (same policy as login).
- **Regression test:** smoke test asserting 429 after N rapid analytics calls.
- **Status:** CONFIRMED (code). Dynamic NOT RUN.

### A-API-06 — P2 — CONFIRMED — Manual sync is once-per-hour-per-website-per-type, and the failure is a confusing generic 409

- **Files:** `apps/web/src/app/api/sync/route.ts` — `jobId = \`${type}:${website.id}:${ISO-hour}\``; `prisma.analyticsSyncJob.create({ …, externalId: jobId })`*before* enqueue.`schema.prisma:499`—`AnalyticsSyncJob.externalId`is`@unique`.
- **Evidence:** a second manual sync for the same website+type within the same UTC hour fails at the `create` with `P2002` (unique `externalId`) → `withApiErrors` maps it to generic 409 `{ error: "conflict" }` with no hint that it is a duplicate trigger. The same failure occurs when retrying after a failed enqueue: the first attempt's row was flipped to `FAILED` but keeps its `externalId`, so a retry in the same hour can never be created. The BullMQ-level dedup is irrelevant — the DB rejects first. Separately, the endpoint's permission is only `analytics.view` (`sync/route.ts` + `hasPermission` check): any viewer, including TEAM_MEMBER, can enqueue sync jobs for any website they can view — a quota/cost decision made by the lowest-privilege role.
- **Impact:** legitimate "sync again" clicks fail with an opaque error for up to an hour; operators cannot retry a failed manual sync in the same hour; low-privilege users can trigger provider spend.
- **Correction:** make manual sync idempotent-by-design — return the existing PENDING/FAILED row (or re-enqueue it) instead of creating a duplicate, with a stable `sync_in_progress`/`already_queued` response; and require a manage-level permission (or at least `website.manage`-adjacent) to trigger a sync, or document the viewer-trigger choice.
- **Regression test:** smoke test: two `POST /api/sync` in the same hour → second returns 200/409 with a _stable, documented_ code and exactly one queue entry; TEAM_MEMBER trigger → 403 (if permission is tightened).
- **Status:** CONFIRMED (code; BullMQ dedup not needed for the conclusion). Dynamic NOT RUN.

### A-API-07 — P3 — CONFIRMED — `PUT /api/reports/schedule` silently drops invalid recipient emails

- **File:** `apps/web/src/app/api/reports/schedule/route.ts` (PUT) — recipients are filtered by regex (`/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`) and invalid entries are discarded without any error or warning; `enabled` is coerced (`body.enabled === true`); `dayOfWeek`/`hourUtc` go through `Number()` so `"2"` is accepted. The `>20 recipients` check happens _after_ filtering, so 25 submitted with 5 invalid passes as 20.
- **Impact:** an admin who typos a recipient believes the report is going out; the schedule saves successfully with a silently different recipient list. Low severity (SUPER_ADMIN-only, self-inflicted) but a real silent-data-loss contract violation.
- **Correction:** return 400 listing the invalid addresses (or echo back the accepted list and require confirmation); validate types strictly with zod.
- **Regression test:** unit/smoke test: PUT with one invalid recipient → 400 (or explicit accepted-list response).
- **Status:** CONFIRMED (code).

### A-API-08 — P3 — CONFIRMED — `PATCH /api/teams/[id]` writes no audit record

- **File:** `apps/web/src/app/api/teams/[id]/route.ts` — PATCH validates (`teamCreateSchema.partial()`), `prisma.team.update`, returns the team. No `writeAudit` call (the file's DELETE handler _does_ audit, line 36). Every other mutating route in the repo audits (teams create/delete, members, websites, transfers, invites, connections, reports, api-keys).
- **Impact:** team renames/slug changes are invisible in the audit trail (`/audit` page), breaking forensic completeness for a privileged mutation (slug changes affect team URLs/identity).
- **Correction:** add `team.updated` audit write (same shape as `team.created`/`team.deleted`).
- **Regression test:** smoke test asserting a PATCH appears in the audit log.
- **Status:** CONFIRMED (code).

### A-API-09 — P3 — CONFIRMED — Pagination is inconsistent; `loadInsights` silently truncates past 50 websites

- **Evidence:** `parsePagination` (`apps/web/src/lib/pagination.ts`) clamps `limit` to 1–200 and floors `offset` at 0, but `offset` is unbounded (deep-offset DoS) and is used by teams/websites/connections/sync-failed. By contrast: `GET /api/v1/websites` hard-codes `take: 500` with no pagination params at all (`v1/websites/route.ts:15`); `GET /api/api-keys` hard-codes `take: 100` (`api-keys/route.ts:18`); `GET /api/v1/health` and `GET /api/integrations/health` accept an unbounded `page` (`Math.max(1, parseInt…)` — page 10⁹ = huge skip); `loadInsights` caps at `MAX_WEBSITES = 50` (`apps/web/src/lib/insights.ts:44`) with **no `truncated` flag** — unlike `loadPortfolio`, which reports `truncated: websiteCount > websites.length` (`apps/web/src/lib/portfolio.ts`). An org with 60 websites silently gets insights for 50 of them.
- **Impact:** clients cannot page v1 websites or api-keys; insights under-report for larger orgs without any signal.
- **Correction:** honour `limit`/`offset` (or cursor) on v1 websites and api-keys; cap `page`; add `truncated` to the insights response.
- **Regression test:** unit tests for `parsePagination` bounds; smoke test for insights `truncated` with >50 websites.
- **Status:** CONFIRMED (code).

### A-API-10 — P3 — CONFIRMED — Disabled Ad Manager returns HTTP 200 with an error payload

- **File:** `apps/web/src/app/api/analytics/ad-manager/route.ts:6-7` — when `GOOGLE_AD_MANAGER_ENABLED` is false, returns `200 { status: "disabled", error: "GOOGLE_AD_MANAGER_ENABLED is false" }`. Every other analytics failure mode returns 4xx/5xx with `{ error }`. Clients that branch on status code treat a disabled provider as success; clients that branch on `error` see an error on a 200.
- **Correction:** return 503 (or 404) with the stable error code, or document the 200 shape as the contract and make all "not configured" responses match it.
- **Regression test:** smoke test asserting the disabled-provider status code.
- **Status:** CONFIRMED (code).

### A-API-11 — P3 — CONFIRMED — Success/error response shapes vary route to route

- **Evidence:** success bodies include `{ status: "ok" }` (most POSTs), `{ ok: true }` (api-key revoke, report send-test uses `{ ok: delivered }`), `{ deleted: true }` (member/org/website deletes), bare `{ key, secret }` / `{ team }` / `{ website }` / `{ transfer, note }`, and the analytics envelope `{ status: "ok", data, includedWebsites, … }`. Error bodies include `{ error }` (most), `{ error, message }` (api-key-auth 401s, `apps/web/src/lib/api-key-auth.ts`), `{ error, details }` (validation), and `{ error, status }` (transfer state errors include the transfer status as a field). `requestId` appears only on `apiError()` responses (see A-API-02).
- **Impact:** every client must special-case per-route shapes; the `api-error.ts` "central API error contract (API-9)" is aspirational rather than enforced.
- **Correction:** adopt one success envelope and one error envelope; lint for raw `NextResponse.json({ error` outside `apiError()`.
- **Regression test:** contract test asserting every route's error body matches the envelope (can be a static test over the route files + smoke assertions).
- **Status:** CONFIRMED (code).

### A-API-12 — P3 — CONFIRMED — `website.transfer` is SUPER_ADMIN-only in practice; `audit.view` has no API route

- **Evidence:** `ROLE_PERMISSIONS` (`packages/auth/src/permissions.ts:22-34`) omits `website.transfer` from TEAM_ADMIN, so `POST /api/websites/[id]/transfer` (`requireApiAuth("website.transfer")`) 403s for every TEAM_ADMIN — the team admins who actually manage teams cannot initiate transfers; only SUPER_ADMIN can. The smoke test's transfer checks use the SUPER_ADMIN jar (`smoke-test.sh:139-140`), so this never surfaces there. Separately, the `audit.view` permission exists in `PERMISSIONS` but **no API route references it** — audit data is readable only via the SUPER_ADMIN-gated server-component page (`apps/web/src/app/(app)/audit/page.tsx:9-16`, `take: 100`, no pagination), so there is no programmatic audit access at all.
- **Impact:** functional gap vs. the likely intent (team admins initiate, destination admins accept); and audit data cannot be consumed by API clients/SIEM.
- **Correction:** confirm intent with the product owner: either grant `website.transfer` to TEAM_ADMIN (with the source-manage check from A-SEC-17) or document SUPER_ADMIN-only transfers; add a paginated `GET /api/audit` behind `audit.view`.
- **Regression test:** smoke test for TEAM_ADMIN-initiated transfer (per the chosen intent); smoke test for `GET /api/audit` scoping.
- **Status:** CONFIRMED (code). Intent question for the owner.

### A-API-13 — P3 — CONFIRMED — Property discovery is unbounded, unthrottled, and sequential-per-account

- **File:** `apps/web/src/app/api/google/properties/discover/route.ts` + `packages/google/src/discovery.ts` — up to 10 pages × 200 accounts for GA4, then up to 10 pages of properties _per account_, each property upserted individually (`prisma.googleProperty.upsert` in a loop). No rate limit on the route (A-API-05), no overall timeout, no cap on total upserts. Partial failures are handled well (per-account isolation, `truncated` flags, classified errors) — the gap is only volume/cost.
- **Impact:** one `POST /api/google/properties/discover` against a large Google account can issue thousands of sequential DB writes and burn API quota; repeated calls have no brake.
- **Correction:** cap total discovered items, batch the upserts (`createMany … skipDuplicates` where the schema allows), add the route to the rate-limit wrapper, and consider a request timeout.
- **Regression test:** unit test for the discovery cap with a mocked paginated client.
- **Status:** CONFIRMED (code). Dynamic NOT RUN.

### A-API-14 — P3 — CONFIRMED — `snapshotUpdatedAt` reports first-write time, not last-write time

- **Evidence:** `AnalyticsCache` has **no `updatedAt` column** (`schema.prisma:485-494` — only `createdAt @default(now())`). `readSnapshot` (`packages/db/src/snapshots.ts:40-46`) returns `{ …, updatedAt: row.createdAt }`, and `writeSnapshot` upserts `payload`/`expiresAt`/`websiteId` without touching `createdAt`. So after the first snapshot for a cache key, `snapshotUpdatedAt` (surfaced by analytics envelopes, portfolio, insights) never advances, and `stale` (derived from `expiresAt`) is the only freshness signal. Dashboards showing "last synced" from this field under-report freshness permanently.
- **Correction:** add `updatedAt DateTime @updatedAt` to `AnalyticsCache` and return it from `readSnapshot`.
- **Regression test:** unit test asserting `readSnapshot` returns the write time after an upsert.
- **Status:** CONFIRMED (code + schema).

### A-API-15 — P3 — CONFIRMED — Organization export is unbounded and unthrottled

- **File:** `apps/web/src/app/api/organization/export/route.ts` — six unbounded `findMany` calls (members, teams, websites incl. integrations, connections, transfers), `JSON.stringify` of the whole payload, no pagination, no size cap, no rate limit. SUPER_ADMIN-only, so the blast radius is a compromised/stale admin session or a runaway script — but a large org export can OOM the serverless function / exhaust the DB connection.
- **Correction:** stream the export (or paginate internally with a row cap + `truncated` flag), add rate limiting, and consider backgrounding large exports.
- **Regression test:** smoke test with a large fixture asserting bounded memory/time or a documented cap.
- **Status:** CONFIRMED (code). Dynamic NOT RUN.

### A-API-16 — P3 — CONFIRMED — `GET /api/v1/websites` silently truncates at 500 with no paging or flag

- **File:** `apps/web/src/app/api/v1/websites/route.ts:15` — `take: 500`, no `limit`/`offset` params, no `total`, no `truncated`. An org with >500 websites gets a silently incomplete list; API consumers have no way to fetch the rest (contrast `loadPortfolio`, which reports `truncated`).
- **Correction:** add pagination params + `total`/`truncated` to the response.
- **Regression test:** unit/smoke test with >500 websites.
- **Status:** CONFIRMED (code).

### A-API-17 — P3 — CONFIRMED — Transfer state transitions are check-then-act, not guarded updates

- **Files:** `apps/web/src/app/api/transfers/[id]/accept|reject|complete|cancel/route.ts` — each loads the transfer, checks `status` in memory, then calls `prisma.websiteTransfer.update({ where: { id }, data: { status: … } })` with **no `status` condition** in the `where`. Two concurrent `accept` calls (or `complete` calls) can both pass the in-memory check and both "succeed"; the second overwrites `acceptedById`/`completedAt`. The `complete` transaction moves the website and deletes assignments/integrations — running it twice is mostly idempotent (`deleteMany`), but the audit log gets two `website.transfer.completed` entries and the second completion re-checks nothing.
- **Correction:** guard the update with `updateMany({ where: { id, status: "PENDING_ACCEPTANCE" }, data: … })` and treat `count === 0` as 409 `invalid_state`.
- **Regression test:** concurrency test: two parallel accepts → exactly one 200, one 409.
- **Status:** CONFIRMED (code). Dynamic race NOT RUN. (Same pattern class as A-SEC-18.)

### A-API-18 — P3 — CONFIRMED — `POST /api/sync` and `POST /api/google/properties/discover` return 503/200 shapes that hide the real state

- **Evidence:** sync trigger returns `{ status: "ok", queued: !!job }` — `queued` is always true when reached (the `!job` branch already returned 503 `queue_unavailable`), so the field carries no information. Discovery returns 200 with partial `errors`/`truncated` maps — correct behaviour, but the route returns 502 `discovery_failed` only when `getValidAccessToken` itself throws, while per-provider failures are 200s with an `errors` map; clients must handle both shapes. Neither is a bug on its own; both are contract roughness in the two most failure-prone endpoints.
- **Correction:** document both shapes in the API contract (or normalize: discovery always 200 with the `errors` map, including token failures as `errors.auth`).
- **Regression test:** smoke assertions for both shapes.
- **Status:** CONFIRMED (code).

---

## Route inventory (all 52, revalidated from source)

Legend: **Auth** = session (`S`), API key (`K`), public (`–`). **RL** = explicit rate limit. **Err** = wrapped in `withApiErrors` (`W`) or not (`–`). **Val** = zod schema or `parsePagination`. External deps: Google (`G`), Redis/BullMQ (`R`), SMTP (`M`).

### Analytics (9) — all `S`, permission per route, via `handleAnalyticsRequest` (auth → permission → zod `analyticsQuerySchema` → `assertWebsiteAccess` or snapshot aggregate → cache → snapshot → live Google). No RL. Err: –.

| #   | Route                           | Method | Permission                | Validation               | DB / external                                                     | Response                                                   |
| --- | ------------------------------- | ------ | ------------------------- | ------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `/api/analytics/overview`       | GET    | `analytics.view`          | query schema, csv opt-in | snapshot/cache/live GA4                                           | analytics envelope; `freshness` live/snapshot/cached/stale |
| 2   | `/api/analytics/traffic`        | GET    | `analytics.view`          | query schema             | GA4                                                               | envelope                                                   |
| 3   | `/api/analytics/audience`       | GET    | `analytics.view`          | query schema             | GA4                                                               | envelope                                                   |
| 4   | `/api/analytics/pages`          | GET    | `analytics.view`          | query schema, csv        | GA4                                                               | envelope or CSV                                            |
| 5   | `/api/analytics/events`         | GET    | `analytics.view`          | query schema             | GA4                                                               | envelope                                                   |
| 6   | `/api/analytics/realtime`       | GET    | `analytics.realtime.view` | query schema             | GA4 realtime, 30 s TTL                                            | envelope                                                   |
| 7   | `/api/analytics/search-console` | GET    | `search_console.view`     | query schema, csv        | Search Console                                                    | envelope or CSV                                            |
| 8   | `/api/analytics/adsense`        | GET    | `adsense.view`            | query schema, csv        | AdSense                                                           | envelope or CSV                                            |
| 9   | `/api/analytics/ad-manager`     | GET    | `ad_manager.view`         | query schema             | Ad Manager; 200 `{status:"disabled"}` when feature off (A-API-10) | envelope                                                   |

No-`websiteId` behaviour (all 9): org aggregate from snapshots via `loadPortfolio` — no live fan-out. Cross-tenant IDs → 404 via `assertWebsiteAccess`. Invalid input → 400. Provider failure → classified code, 429 on quota / 502 otherwise, with stale-cache/snapshot fallback served as `freshness: "stale"`.

### API keys (2)

| #   | Route                | Method | Permission            | Validation                  | DB / external                                             | Response                           |
| --- | -------------------- | ------ | --------------------- | --------------------------- | --------------------------------------------------------- | ---------------------------------- |
| 10  | `/api/api-keys`      | GET    | `organization.manage` | – (take 100, no pagination) | list, org-scoped                                          | `{ keys }` (no secrets, no hashes) |
| 11  | `/api/api-keys`      | POST   | `organization.manage` | name string ≤80             | create; secret returned **once**                          | 201 `{ key, secret }`              |
| 12  | `/api/api-keys/[id]` | DELETE | `organization.manage` | –                           | revoke (`revokedAt`); idempotent no-op if already revoked | `{ ok: true }`                     |

### Auth (3 files; `[...all]` mounts the whole better-auth surface)

| #   | Route                | Method   | Auth            | Validation / RL                                                 | Notes                                                                                                                                                                      |
| --- | -------------------- | -------- | --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | `/api/auth/[...all]` | GET/POST | better-auth     | better-auth global 100/min + 3/10 s on sign-in/sign-up/change-* | sign-up, sign-in, sign-out, session, verify-email, forget/reset-password, change-password/email, two-factor verify; `delete-user` disabled (no `user.deleteUser.enabled`). |
| 14  | `/api/auth/login`    | POST     | – (credentials) | zod email/password; RL 10/min/IP fail-closed                    | 401 `invalid_credentials`; 2FA → `{ status: "two_factor_required" }` + pending cookie                                                                                      |
| 15  | `/api/auth/logout`   | POST     | –               | –                                                               | revokes session, forwards Set-Cookie                                                                                                                                       |

### Google (7)

| #   | Route                                | Method | Permission                 | Validation                                               | DB / external                                                                                                 | Response                                                                                              |
| --- | ------------------------------------ | ------ | -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 16  | `/api/google/connections`            | GET    | `google.connection.view`   | pagination                                               | visibility-scoped list                                                                                        | `{ connections, pagination }` + `needsReauth` flags                                                   |
| 17  | `/api/google/connections/disconnect` | POST   | `google.connection.manage` | zod `connectionId`                                       | visibility check → `revokeConnection` (Google revoke, best-effort) → audit, cache+snapshot invalidate         | `{ status: "ok" }`                                                                                    |
| 18  | `/api/google/oauth/connect`          | GET    | `google.connection.manage` | zod query ownerType/ownerId; RL 10/min fail-closed       | owner-access check → `buildAuthUrl` (PKCE + state)                                                            | 302 to Google; 503 if OAuth unconfigured                                                              |
| 19  | `/api/google/oauth/callback`         | GET    | state + session binding    | RL 20/min/IP fail-closed; HMAC state; single-use consume | code exchange → profile → upsert connection (encrypted tokens, AAD) → audit                                   | 302 to `/integrations?oauth=…`                                                                        |
| 20  | `/api/google/properties/discover`    | POST   | `google.connection.manage` | zod `connectionId`                                       | visibility → token refresh → 3 providers in parallel → upserts (A-API-13)                                     | `{ ga4, searchConsole, adsense, errors?, truncated?, partial? }`                                      |
| 21  | `/api/google/properties/map`         | POST   | `google.connection.manage` | `mapPropertySchema`                                      | website-manage + discovered-property resolution + visibility + connection scope → tx (single-primary) → audit | `{ integration }`; 400 `property_not_discovered` / `ambiguous_property` / `connection_scope_mismatch` |

### Health / insights / invites / members / metrics / organization / reports (13)

| #   | Route                      | Method  | Permission            | Validation                                                                  | DB / external                                                                             | Response                                                     |
| --- | -------------------------- | ------- | --------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 22  | `/api/health`              | GET     | – public              | –                                                                           | none                                                                                      | `{ status: "ok", ts }`                                       |
| 23  | `/api/health/ready`        | GET     | – public              | –                                                                           | `SELECT 1` + Redis ping                                                                   | 200 `ready` / 503 `not_ready` + `checks`                     |
| 24  | `/api/insights`            | GET     | `analytics.view`      | –                                                                           | snapshots, ≤50 sites (A-API-09)                                                           | insights result                                              |
| 25  | `/api/integrations/health` | GET     | `analytics.view`      | `page` (unbounded)                                                          | `IntegrationHealth`, 50/page                                                              | overview + summary                                           |
| 26  | `/api/invites/accept`      | POST    | S (any)               | zod `token`                                                                 | token-hash lookup, email match, shell-org move tx, old-org delete best-effort             | `{ status: "ok" }` / 403 email mismatch / 409 already-in-org |
| 27  | `/api/members/[id]`        | PATCH   | `member.manage`       | `memberRoleSchema`                                                          | org-scoped; self/last-SA guards                                                           | `{ member }`                                                 |
| 28  | `/api/members/[id]`        | DELETE  | `member.manage`       | –                                                                           | org-scoped; dependency 409 (connections/transfers)                                        | `{ deleted: true }`                                          |
| 29  | `/api/members/invite/[id]` | DELETE  | `member.manage`       | –                                                                           | org-scoped invite revoke                                                                  | `{ status: "ok" }`                                           |
| 30  | `/api/members/invite`      | POST    | `member.manage`       | `inviteCreateSchema` (TA/TM only); RL 20/min fail-closed                    | replaces pending invites; 7 d TTL; SHA-256 token hash; email via SMTP (failure swallowed) | 201 `{ invite, inviteUrl }`                                  |
| 31  | `/api/metrics`             | GET     | S + SA role           | –                                                                           | **no org filter (A-API-01)**; queue counts via BullMQ                                     | counters/cache/sync24h/dlq/queues                            |
| 32  | `/api/organization/export` | GET     | `organization.manage` | –                                                                           | 6 unbounded `findMany` (A-API-15)                                                         | JSON attachment; audit                                       |
| 33  | `/api/organization`        | DELETE  | `organization.manage` | zod `confirmSlug`                                                           | revoke tokens best-effort → delete audit + org in tx                                      | `{ deleted: true }`                                          |
| 34  | `/api/reports/schedule`    | GET/PUT | `organization.manage` | PUT: dayOfWeek 0–6, hourUtc 0–23, recipients ≤20, regex-filtered (A-API-07) | upsert schedule                                                                           | `{ schedule }`                                               |
| 35  | `/api/reports/send-test`   | POST    | `organization.manage` | –                                                                           | portfolio+health from snapshots; `sendMail` to caller                                     | `{ ok: delivered, to }`                                      |

### Sync / teams / transfers (12)

| #   | Route                          | Method | Permission                    | Validation                | DB / external                                                                                | Response                                                                         |
| --- | ------------------------------ | ------ | ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 36  | `/api/sync/failed`             | GET    | S + SA role                   | pagination                | **no org filter (A-API-01)**                                                                 | `{ jobs, pagination }` incl. `payload`, `lastError`                              |
| 37  | `/api/sync/requeue`            | POST   | S + SA role                   | zod `jobId`               | **no org filter (A-API-01)**; state must be FAILED; `enqueue` (unique jobId)                 | `{ status: "ok", jobId, queue }` / 409 `invalid_state` / 503 `queue_unavailable` |
| 38  | `/api/sync`                    | POST   | `analytics.view` (any viewer) | zod websiteId + type enum | `assertWebsiteAccess`; create PENDING row (hourly deterministic jobId — A-API-06); `enqueue` | `{ status: "ok", queued }` / 503 `queue_unavailable`                             |
| 39  | `/api/teams`                   | GET    | `team.view`                   | pagination                | org-wide list + `_count`                                                                     | `{ teams, pagination }`                                                          |
| 40  | `/api/teams`                   | POST   | `team.manage`                 | `teamCreateSchema`        | create; P2002 slug → 409                                                                     | 201 `{ team }`                                                                   |
| 41  | `/api/teams/[id]`              | PATCH  | `team.manage`                 | partial schema            | `assertTeamAccess`; **no audit (A-API-08)**; P2002 → 409                                     | `{ team }`                                                                       |
| 42  | `/api/teams/[id]`              | DELETE | `team.manage`                 | –                         | `assertTeamAccess`; 409 if websites                                                          | `{ status: "ok" }`                                                               |
| 43  | `/api/teams/[id]/members`      | POST   | `member.manage`               | zod userId/isAdmin/action | `assertTeamAccess`; add (upsert) / remove; last-admin guard                                  | `{ status: "ok" }`                                                               |
| 44  | `/api/transfers/[id]/accept`   | POST   | S + dest-team admin           | –                         | org-scoped load; lazy expiry; state PENDING_ACCEPTANCE → PENDING_CONNECTION                  | `{ transfer, note }`                                                             |
| 45  | `/api/transfers/[id]/reject`   | POST   | S + dest-team admin           | –                         | → CANCELLED                                                                                  | `{ transfer }`                                                                   |
| 46  | `/api/transfers/[id]/cancel`   | POST   | S + initiator/SA              | –                         | open states → CANCELLED                                                                      | `{ transfer }`                                                                   |
| 47  | `/api/transfers/[id]/complete` | POST   | S + dest-team admin           | –                         | requires ACTIVE dest-team connection; tx moves team, clears assignments + integrations       | `{ transfer, note }`                                                             |

Transfer state machine is otherwise sound: nothing moves before completion; OAuth tokens are never transferred; open-transfer uniqueness is DB-backed (P2002 → 409); expiry is lazy (`expireIfStale`) with a 7-day TTL. Race noted in A-API-17.

### Public API v1 (5) — all `K` (API key), rate-limited 120/min/key, snapshot-only (never trigger live Google calls)

| #   | Route                             | Method | Validation                                                  | DB / external                                            | Response                                                                                                          |
| --- | --------------------------------- | ------ | ----------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 48  | `/api/v1/health`                  | GET    | `page` (unbounded)                                          | `loadHealthOverview` (accessible websites)               | health overview                                                                                                   |
| 49  | `/api/v1/insights`                | GET    | –                                                           | `loadInsights` (≤50 sites)                               | insights result                                                                                                   |
| 50  | `/api/v1/portfolio`               | GET    | provider/report enum validation; `range` via `resolveRange` | `loadPortfolio` (limit 200, `truncated` flag)            | `{ provider, report, range, totals, totalsNote, websiteCount, includedWebsites, unavailableWebsites, truncated }` |
| 51  | `/api/v1/websites`                | GET    | –                                                           | org-wide, `take: 500`, no pagination (A-API-16)          | `{ websites }`                                                                                                    |
| 52  | `/api/v1/websites/[id]/analytics` | GET    | report enum; `range`                                        | org-scoped website → primary integration → snapshot read | `{ status: "ok" \| "no_snapshot_yet" \| "no_property_mapped", data, … }`                                          |

### Websites (5 routes, 8 methods — counted in the 52 as files; methods listed for completeness)

| Route                         | Method | Permission                             | Validation                                                         | Notes                                                                                                 |
| ----------------------------- | ------ | -------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `/api/websites`               | GET    | `website.view`                         | pagination; `q` search; `status` **unvalidated (A-API-03)**        | scoped by `listAccessibleWebsiteIds`                                                                  |
| `/api/websites`               | POST   | `website.manage`                       | `websiteCreateSchema` (status enum excludes TRANSFER_PENDING/SOLD) | dest-team manage check; P2002 → 409 `domain_taken`                                                    |
| `/api/websites/[id]`          | GET    | `website.view`                         | –                                                                  | `assertWebsiteAccess`; includes team, assignments (+user email/name), integrations, last 10 transfers |
| `/api/websites/[id]`          | PATCH  | `website.manage`                       | partial schema                                                     | manage access; dest-team manage check on move; tx re-verifies dest team; P2002 → 409                  |
| `/api/websites/[id]`          | DELETE | `website.manage`                       | –                                                                  | manage access; cascades (integrations, assignments, transfers, sync jobs, website connections)        |
| `/api/websites/[id]/assign`   | POST   | `website.assign`                       | zod userId/action                                                  | manage access; org-scoped target; upsert/delete                                                       |
| `/api/websites/[id]/transfer` | POST   | `website.transfer` (SA-only, A-API-12) | `transferSchema`                                                   | org-scoped website + dest team; `already_in_team` 400; open-transfer 409; P2002 race → 409            |

Note on the count: the 52 `route.ts` files contain 60+ exported handlers (several files export GET+POST / PATCH+DELETE). The inventory above covers every file and every handler.

## Test-coverage mapping (endpoint logic vs. tests)

| Case class                    | Covered by unit tests (mocked)                                                           | Covered by CI smoke test (live)                                                                 | Untested anywhere                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Unauthenticated (401)         | `api-error.test.ts` (contract shapes only)                                               | login page, metrics 401, member requeue 403                                                     | Most routes' 401 path (no route tests)                                                                       |
| Insufficient permission (403) | `permissions.test.ts` (role table only)                                                  | transfer by member 403, member requeue 403, update-user escalation, cross-org website/oauth 403 | 403 paths for api-keys, members, org export/delete, reports, teams, websites                                 |
| Invalid input (400)           | `validation.test.ts`, `pagination.test.ts`                                               | SOLD status 400, unmapped property 400                                                          | `status` filter 500 (A-API-03), schedule recipient coercion (A-API-07)                                       |
| Cross-tenant IDs (404)        | `tenant-isolation.test.ts` (helpers, mocked Prisma)                                      | cross-org website create, cross-org OAuth connect, connection visibility                        | **A-API-01 (sync/metrics)** — no multi-org DLQ/metrics test                                                  |
| Duplicates / races            | `transfer.test.ts` (state machine), `refresh-lock.test.ts`                               | duplicate open transfer 409, last-admin guard, single-primary rule                              | A-API-06 (hourly sync dup), A-API-17 (transfer double-accept), A-SEC-18 (last-admin race)                    |
| Pagination                    | `pagination.test.ts`, `discovery-pagination.test.ts`                                     | –                                                                                               | Deep-offset, v1 500-cap, insights 50-cap (A-API-09/16)                                                       |
| Idempotency                   | – (none)                                                                                 | –                                                                                               | api-key revoke is idempotent by code; sync trigger is _not_ idempotent (A-API-06); invite re-create replaces |
| Error schemas                 | `api-error.test.ts`                                                                      | `x-request-id` header check                                                                     | A-API-02 (19 unwrapped routes), A-API-11 (shape variance)                                                    |
| Rate limiting                 | `rate-limit.test.ts`, `rate-limit-failclosed.test.ts`                                    | login rate-limit vs. verification block (smoke)                                                 | A-API-05 (47 routes have no limit to test)                                                                   |
| Snapshot/cache correctness    | `snapshot-ttl.test.ts`, `cache-keys.test.ts`, `portfolio.test.ts`, `sync-engine.test.ts` | analytics `not_connected` before fixture; snapshot flows in journeys                            | A-API-14 (`snapshotUpdatedAt` = `createdAt`)                                                                 |

**Server actions / components that call services:** there are **no `"use server"` server actions** in the app (verified by grep). Pages are async server components that query Prisma directly and call the same loaders as the API (`loadPortfolio`, `loadInsights`, `loadHealthOverview`): `(app)/layout.tsx` gates every app page on a session (`redirect("/login")`); `(app)/members/page.tsx` and `(app)/teams/page.tsx` read org-wide without a permission gate (A-SEC-10); `(app)/audit/page.tsx` is SUPER_ADMIN-gated. Client components (`WebsiteActions.tsx` etc.) call the API routes via `fetch` and `router.refresh()`.

## Verdict table (Phase 2)

| Category                                 | Verdict     | Basis                                                                                                                                                |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route inventory completeness             | **PASS**    | All 52 files / 60+ handlers inventoried; auth, permission, validation, DB ops, external deps, errors, RL, response shape recorded.                   |
| Authorization correctness (per-route)    | **FAIL**    | One P1 cross-tenant hole (A-API-01); sync trigger open to viewers (A-API-06); transfer SA-only vs. intent (A-API-12).                                |
| Validation & error handling              | **FAIL**    | 500 on invalid `status` (A-API-03); 19 routes outside the error contract (A-API-02); silent coercions (A-API-03/07).                                 |
| Idempotency & duplicates                 | **FAIL**    | Sync trigger once-per-hour with opaque 409 (A-API-06); transfer transitions unguarded (A-API-17).                                                    |
| Pagination & bounds                      | **FAIL**    | Unbounded export/discovery, silent truncations (A-API-09/13/15/16).                                                                                  |
| Rate limiting                            | **FAIL**    | 47/52 routes unthrottled (A-API-05).                                                                                                                 |
| Response-shape consistency               | **FAIL**    | Multiple success/error envelopes (A-API-11); disabled-provider 200 (A-API-10).                                                                       |
| Data correctness (snapshots/aggregation) | **PASS**    | Portfolio/insights/health aggregation is snapshot-first, never invents numbers, flags unavailable/truncated — except `snapshotUpdatedAt` (A-API-14). |
| Test coverage (route level)              | **FAIL**    | Zero route-level tests; only the CI smoke test exercises endpoints live, single-org only.                                                            |
| Dynamic endpoint testing                 | **NOT RUN** | No DB/Redis in sandbox; smoke test reads as CI evidence only, not executed here.                                                                     |

## Counts

| Severity  | Count  | IDs                                              |
| --------- | ------ | ------------------------------------------------ |
| P0        | 0      | —                                                |
| P1        | 1      | A-API-01                                         |
| P2        | 5      | A-API-02, A-API-03, A-API-04, A-API-05, A-API-06 |
| P3        | 12     | A-API-07 – A-API-18                              |
| **Total** | **18** |                                                  |

**Top priority before production:** fix A-API-01 (org scoping, same fix as A-SEC-01), A-API-02 (wrap all routes in the error contract), A-API-03 (validate `status`), and A-API-06 (idempotent manual sync). The systemic fix underneath most P2/P3 items is a shared route wrapper combining `withApiErrors` + auth + rate limiting + audit (best-effort), plus route-level tests — the repo currently has none, so every finding above rests on code reading and the single-org CI smoke test.
