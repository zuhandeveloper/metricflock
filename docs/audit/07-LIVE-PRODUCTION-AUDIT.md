# 07 — Live Website and Production Environment Audit

Audit date: 2026-11-23. Auditor: independent audit (coordinator pass).
Target: https://metricflock.bond (Vercel, production target, main HEAD `6e6d2b21`).

## 0.1 How this phase was verified

- Read-only text fetches (`browser.open`) of public URLs on 2026-11-23
  23:27 UTC: `/api/health`, `/login`, `/api/health/ready`, `/og.png`,
  `/favicon.ico`. No sign-in, no forms submitted, no customer data
  touched, no destructive actions.
- Vercel connector `list_deployments` (project `metricflock`).
- GitHub Actions runs list (public, branch main).
- Source review of the health/readiness routes and deployment docs.
- **Limits:** response headers (CSP nonce, HSTS, etc.) cannot be
  inspected via text fetch — header behavior is verified indirectly by
  the CI e2e security-headers test (CI #207: passed). Authenticated
  workflows (dashboard, Google connect, analytics pages) are BLOCKED —
  no authorized test account is available to this auditor and real
  customer data must not be touched. Live Google data states below are
  per prior verified reports, restated as UNVERIFIED where noted.

## 0.2 Verified live results

| Check                                | Result                                                             | Evidence                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel production deployment of HEAD | READY                                                              | `list_deployments`: latest production deployment `dpl_9znceNrs2HLJChQB89bmEu9hvmZe`, state READY, target production, `githubCommitSha 6e6d2b21…`, ref main |
| Liveness `/api/health`               | PASS — `{"status":"ok","ts":"2026-11-23T23:27:13.084Z"}`           | Live fetch 2026-11-23 23:27 UTC                                                                                                                            |
| Login page `/login`                  | PASS — renders "Sign in to MetricFlock", logo.svg loads            | Live fetch 2026-11-23 23:27 UTC                                                                                                                            |
| Brand logo `/logo.svg`               | PASS (200, renders)                                                | Image reference on login page fetch                                                                                                                        |
| `/og.png`                            | **404** (confirmed live)                                           | Fetch returned HTTP 404                                                                                                                                    |
| `/favicon.ico`                       | **404** (confirmed live)                                           | Fetch returned HTTP 404                                                                                                                                    |
| CI on HEAD (CI #207)                 | SUCCESS (5m 24s): unit 196/196, smoke ALL CHECKS PASSED, e2e 24/24 | Prior verified CI report + Actions runs list (CI #207 for 6e6d2b2)                                                                                         |

## 0.3 Findings

### A-LIVE-01 (P1, CONFIRMED-BY-EXECUTION) — Readiness endpoint persistently returns HTTP 503: Redis is down

- **File:** `apps/web/src/app/api/health/ready/route.ts:9-33`.
- **Evidence:** live fetch of `https://metricflock.bond/api/health/ready` on
  2026-11-23 23:27 UTC returned HTTP 503 (fetch failed after 3 attempts
  with `http_status=503`). The route returns 503 exactly when
  `checks.db !== "ok"` (Prisma `SELECT 1` threw) **or**
  `checks.redis === "down"` (a configured Redis failed `PING`); it
  returns 200 `ready` otherwise. The 503 body was not observable via
  text fetch, so which dependency failed is unknown.
- **Dynamic verification 2026-11-23 (live browser task, read-only, no sign-in): CONFIRMED-BY-EXECUTION — the 503 is persistent, not a one-off.** `/api/health/ready` returned **503 twice, ~2 minutes apart** (16:52–16:56 MST), both times with body `{"status":"not_ready","checks":{"db":"ok","redis":"down"}}` — the database is fine; **production has a `REDIS_URL` configured but the Redis instance is down/unreachable**. The same check also confirmed: homepage `/` → 307 to `/login` (200, renders fully: logo, "Sign in to MetricFlock", Continue with Google, email/password fields); `/api/health` → 200 `{"status":"ok"}`; security headers Grade A+ on securityheaders.com (nonce CSP, HSTS, X-Frame-Options DENY, nosniff, referrer-policy, permissions-policy); `/og.png` and `/favicon.ico` still 404 (A-LIVE-02, unchanged). No visible console errors on `/login` (rendered-page check only; DevTools console pane was not directly readable). For contrast, the local app server booted during the same verification (no `REDIS_URL` set) reports `{"status":"ready","checks":{"db":"ok","redis":"disabled"}}` — so the production 503 is specifically the configured-but-down Redis, not a missing one.
- **Why only POTENTIAL:** a single crawled observation cannot distinguish
  a real dependency outage from a transient fetch/cold-start artifact.
  Note the liveness endpoint (`/api/health`) returned 200 at the same
  minute, so the web instance itself was up. **Re-verify before acting:**
  the parent agent should re-check `/api/health/ready` in a live browser
  (or `curl -i`) and, if 503 persists, inspect Vercel runtime logs for
  the `readiness: database check failed` / `readiness: redis check
failed` log lines. If the DB check is failing, every authenticated
  request would also be failing — check the login flow as the
  user-facing test.
- **Impact if confirmed:** the app cannot serve traffic (DB down) or its
  Redis-backed features are down; Vercel's readiness probe would mark
  the deployment not-ready. Also note: if production has no Redis
  configured at all, `checks.redis` is `"disabled"` (not a failure) —
  but then scheduled sync/alerts/reports cannot run, which matches the
  known "worker not deployed" state.
- **Correction:** re-verify; if DB is down, restore DB connectivity
  (Prisma Postgres `db.prisma.io`) before any release; if Redis is down,
  either restore it or confirm the degraded-no-Redis posture is intended
  and document it. Add a CI/live probe that alerts on sustained
  `/api/health/ready` 503 (currently no monitoring is known to exist —
  see A-LIVE-03).
- **Regression test requirement:** none in-repo (live probe); add an
  external uptime check on `/api/health/ready` with alerting.
- **Status:** CONFIRMED-BY-EXECUTION (2026-11-23): persistent 503, cause `redis: down`, `db: ok`. Fix is operational: restore the Redis instance (or remove `REDIS_URL` to accept the documented degraded mode), then re-check.

### A-LIVE-02 (P2) — `/og.png` and `/favicon.ico` return 404 in production

- **File:** `apps/web/src/app/layout.tsx` (references), repo root (binaries
  absent — the GitHub connector cannot upload binary files).
- **Evidence:** live fetches 2026-11-23 returned HTTP 404 for both URLs.
  `/logo.svg` works. Known since 2026-11-21; still present at HEAD.
- **Impact:** broken social-share previews (og.png) and missing favicon
  (browser tab shows default icon); unprofessional but not functional.
- **Correction:** upload both binaries via the GitHub web UI (owner-only
  action) or serve them from Vercel blob storage.
- **Status:** CONFIRMED.

### A-LIVE-03 (P2) — No error monitoring / alerting is configured for production

- **Evidence:** no Sentry/observability integration found in source or
  Vercel project config review; the only production signals are
  `/api/health`, `/api/health/ready`, and `/api/metrics` (SUPER_ADMIN).
  A-LIVE-01 (a 503 readiness) would only be noticed if someone looks.
- **Impact:** outages and provider failures are discovered by users,
  not by the team; health alerts (Phase 7.2) only fire when the worker
  is deployed, which it is not.
- **Correction:** add an external uptime monitor on `/api/health/ready`
  (e.g. UptimeRobot/Better Stack free tier) and wire Vercel log drains
  or Sentry for runtime errors.
- **Status:** CONFIRMED (absence verified by search).

### A-LIVE-04 (P2) — Worker not deployed: scheduled production behavior is absent

- **Evidence:** no worker deployment exists (Vercel project has only the
  web app; Railway/Fly/Render hosting undecided; Dockerfile exists at
  `apps/worker/Dockerfile`). Consequence: scheduled GA4/SC/AdSense
  syncs, snapshot warming, health-transition alert emails, and weekly
  report sends do not run in production. Dashboards fall back to
  live-on-miss (hybrid) and "Sync now" returns 503 `queue_unavailable`
  without Redis.
- **Impact:** the product's scheduled/automation surface is
  code-complete but operationally dead; health alerts and reports —
  headline Phase 7 features — cannot fire.
- **Correction:** deploy the worker (Railway Hobby $5/mo recommended in
  the deploy pack) with the same `DATABASE_URL`, `REDIS_URL`, and
  `GOOGLE_TOKEN_ENCRYPTION_KEY` as production.
- **Status:** CONFIRMED.

### A-LIVE-05 (P3) — Live Google data verification is partial

- **Search Console:** VERIFIED live 2026-11-21 (5 clicks / 170
  impressions matched the owner's GSC UI) — per prior verified report;
  not re-verified in this audit (needs the owner's account).
- **GA4:** UNVERIFIED — REST rewrite is CI-green but no live GA4 data
  has been confirmed on the production site.
- **AdSense:** UNVERIFIED — earnings card was stuck "Loading…" in the
  owner's last screenshot; no error code captured.
- **Ad Manager:** UNVERIFIED — no live account exercised; beta-labeled.
- **Impact:** the product's core value (live analytics) is only
  one-provider verified in production.
- **Correction:** owner refreshes the website page on metricflock.bond
  and reports GA4/AdSense results; diagnose from any error code shown.
- **Status:** CONFIRMED as a gap (verification state, not a code defect).

## 0.4 Verdict table

| Category                    | Verdict                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Homepage / login render     | PASS (observed live)                                                                             |
| Liveness                    | PASS (observed live)                                                                             |
| Readiness                   | **FAIL — CONFIRMED-BY-EXECUTION (A-LIVE-01)**                                                    |
| Deployment configuration    | PASS (Vercel READY on HEAD)                                                                      |
| Static assets               | FAIL (og.png/favicon 404 — A-LIVE-02)                                                            |
| Security headers            | NOT RUN (directly; covered by CI e2e test — passed CI #207)                                      |
| Authenticated workflows     | BLOCKED (no authorized test account available to auditor)                                        |
| Error monitoring            | FAIL (none configured — A-LIVE-03)                                                               |
| Worker/scheduled operations | FAIL (not deployed — A-LIVE-04)                                                                  |
| Live Google data            | PARTIAL (SC verified; GA4/AdSense/Ad Manager unverified — A-LIVE-05)                             |
| Backup and recovery         | NOT RUN (provider PITR assumed; restore drill exists in CI per repo docs — not re-verified live) |
