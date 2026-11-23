# Implementation Plan — 2026-11-21

Derived from `docs/audit/SECURITY-FINDINGS.md`. Rules for every phase:
work on `main`; **no commit/push without explicit instruction**; every
security fix ships with a regression test; no claim of "fixed" without
test output; latest stable versions only; verify branch-head files
before any push (web-UI edits happen).

## Phase 1 — P0 tenant isolation (do first, gate for everything else)

| #   | Work                                                                                                                                    | Findings | Tests                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| 1.1 | PATCH/DELETE `/api/websites/[id]` → `assertWebsiteManageAccess`                                                                         | F-1.1    | Smoke: assigned-viewer TEAM_ADMIN blocked; team isAdmin OK; SUPER_ADMIN OK; cross-org 404 |
| 1.2 | Create: manage-check destination team. PATCH `teamId`: manage-check current + destination, transactional                                | F-1.2    | Smoke: cross-team create/move blocked both directions; failed move leaves data unchanged  |
| 1.3 | Map route: `assertConnectionVisible` + owner-scope match (team conn of website's team, or website's own conn); enforce in service layer | F-1.3    | Smoke: Team A cannot map via Team B connection; same-team still works                     |
| 1.4 | Permission matrix doc + route-by-route assert audit (every mutating route uses manage-tier)                                             | F-1.4    | Smoke matrix additions; doc in `docs/security/overview.md`                                |

**Gate:** all Phase 1 smoke tests green in CI; legitimate team workflows unaffected.

## Phase 2 — Auth/OAuth/secrets

| #   | Work                                                                                                                                                         | Findings    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 2.1 | Add `openid`+`email` to connect scopes; pass `admanager.readonly` when Ad Manager enabled; per-provider scope inspection + reauth-required state + UI prompt | F-2.1a–d    |
| 2.2 | Explicit `organizationId` comparison at OAuth callback; confirm org-mismatch + PKCE-mismatch smoke cases                                                     | F-2.2 notes |
| 2.3 | Mailer: production never logs bodies; throw/fail-startup without SMTP; dev preview behind explicit flag                                                      | F-2.3       |
| 2.4 | Explicit envelope-version check in crypto decrypt                                                                                                            | F-2.4 note  |
| 2.5 | Pin explicit better-auth `rateLimit` config + `useSecureCookies` in production                                                                               | F-2.5 notes |

**Gate:** OAuth scope tests, mailer log tests, crypto tests green; reconnect flow verified in smoke.

## Phase 3 — Rate limiting, refresh, pagination

| #   | Work                                                                                                                                                                  | Findings |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 3.1 | Rate-limit policy per endpoint class (fail-closed for sensitive when Redis configured-but-down); trusted IP derivation; `ratelimit.*` counters; limit invite creation | F-3.1    |
| 3.2 | Refresh lock fail-closed when Redis configured; unlocked only in explicit no-Redis mode (logged/metered); fencing check before DB write                               | F-3.2    |
| 3.3 | Discovery pagination (GA4/AdSense/Ad Manager) with cap + loop guard + `truncated`; per-account isolation; GA4 report `truncated` flag                                 | F-3.3    |
| 3.4 | Ad Manager: retry+timeout, date validation, CTR-total fix, beta label in UI/README                                                                                    | F-3.4    |

**Gate:** Redis-outage tests, refresh-concurrency tests, multi-page fixtures green.

## Phase 4 — Data integrity & lifecycle

| #   | Work                                                                                                                                         | Findings   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 4.1 | Composite FKs (integration property↔connection) or transactional service checks; tighten owner CHECK when legacy columns drop                | F-4.1      |
| 4.2 | Transfer initiate race → clean 409                                                                                                           | F-4.2 note |
| 4.3 | **Decision needed:** deletion/retention/export policy (org deletion vs audit retention, user anonymization) — document first, then implement | F-4.3      |

**Gate:** integrity tests (direct-insert violations rejected); policy doc approved before implementation.

## Phase 5 — Workers/perf/scale

| #   | Work                                                                                                                              | Findings    |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 5.1 | **Decision needed:** snapshot-first dashboards (persist worker snapshots, serve from DB) — requires worker hosting decision first | F-5.4       |
| 5.2 | Backoff jitter; job priorities (recently-viewed first)                                                                            | F-5.5 notes |
| 5.3 | Load benchmarks at 100/1k/10k websites (job generation, throughput, quota)                                                        | brief 5.3   |
| 5.4 | Dashboard page query pagination/aggregation                                                                                       | F-5.6       |

**Gate:** measured benchmark results recorded; no uncontrolled provider fan-out.

## Phase 6 — Audit/CSP/supply chain

| #   | Work                                                                                                | Findings    |
| --- | --------------------------------------------------------------------------------------------------- | ----------- |
| 6.1 | Value-level redaction in audit scrubbing + shared `sanitizeProviderError` for store/email/log paths | F-6.7       |
| 6.2 | Nonce-based CSP via `proxy.ts`; narrow `img-src`; e2e assertions                                    | F-6.8       |
| 6.3 | Pin semgrep version in security-audit workflow; SBOM generation (optional)                          | F-6.9 notes |

**Gate:** sanitization tests with realistic secrets; CSP verified against real routes.

## Phases 7–9 — Product, UX, release gates (after P0/P1 gates)

Phase 7 features (portfolio/SEO/revenue intelligence, reporting, health
monitoring, alerts, asset management, developer platform) each need a
user story, permission model, data source, API contract, UI, tests and
docs before implementation — and snapshot data (5.1) for most of them.
**7.1 (2026-11-22): portfolio aggregation (DATA-6)** — org totals from
per-website snapshots via `apps/web/src/lib/portfolio.ts` (GA4 overview,
Search Console, AdSense; rates recomputed from summed totals,
underivable metrics null, snapshot-less websites reported unavailable);
the analytics handler's no-websiteId stub now serves real aggregates;
dashboard gained a Portfolio totals section. **7.2 (2026-11-22): health
monitoring + alerts** — `/health` page + `GET /api/integrations/health`
(healthy/error/stale derivation in `@metricflock/shared/health-state`,
48h stale window, accessible-website scoping, `analytics.view`
permission); worker wraps `recordHealth` to email org SUPER_ADMINs
once per ok→error transition (and once on recovery), sanitized error
text. **7.3 (2026-11-23): scheduled email reporting** — `ReportSchedule`
model + migration `20261123000000_report_schedules` (one schedule per
org; weekday/hour UTC; empty recipients = SUPER_ADMINs) +
`SCHEDULED_REPORT` sync-job type; aggregation math moved to
`@metricflock/shared` (`portfolio-aggregate`) so web and worker share
it; report email builder + `isReportDue` in shared; worker scheduler
enqueues due reports (new `scheduled-report` queue), worker builds
from 28-day snapshots and sends via the mailer (lastSentAt recorded
only when SMTP actually delivered); `/settings/reports` page
(SUPER_ADMIN) with schedule form + send-test; APIs
`/api/reports/schedule` (GET/PUT) and `/api/reports/send-test`, both
`organization.manage`; audit `report.schedule_updated` /
`report.test_sent`; tests report.test.ts. Remaining Phase 7 slices
(SEO/revenue intelligence, developer platform) on
Gulzaib's priority choice.
Phase 8 UX/a11y work builds on the existing Playwright+axe harness.
Phase 9 release gates: full check suite + live-data verification per
provider (GA4/AdSense still pending user-side confirmation) + worker
hosting.

## Decisions needed from Gulzaib (in order)

1. Approve Phase 1 implementation (P0) — or adjust scope.
2. Worker hosting (Railway recommended earlier) — blocks 5.1 and scheduled sync in production.
3. Deletion/retention/export policy direction (4.3).
4. Snapshot-first dashboards yes/no (5.1).
5. Which Phase 7 features first (after gates).
