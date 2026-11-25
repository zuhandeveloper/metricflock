# Phase 5 — Workers, Queues, Scheduling & Scalability Audit

**Repo:** `~/workspace/metricflock/` · **HEAD:** `6e6d2b21` · **Date:** 2026-11-23
**Auditor:** independent production-readiness audit (Phase 5 of 9)
**Scope:** `apps/worker/src` (`index.ts`, `scheduler.ts`, `report.ts`),
`packages/jobs/src` (`queue.ts`, `scheduler.ts`), `packages/google/src/sync.ts`,
`packages/db/scripts/benchmark-scale.ts` + `docs/audit/BENCHMARKS.md`,
plus the worker-adjacent surfaces those files touch: `packages/shared/src`
(`cache.ts`, `rate-limit.ts`, `report.ts`, `health-state.ts`),
`packages/auth/src/mailer.ts`, `packages/db/src/snapshots.ts`,
`packages/db/src/health.ts`, `apps/web/src/app/api/sync/*` (manual sync,
DLQ list/requeue), `apps/worker/Dockerfile`, `docker-compose.yml`,
BullMQ 6.7.7 (installed) semantics.

## Method & limits — read first

- **No prior audit doc was trusted.** Every claim below was re-checked against
  current source at HEAD `6e6d2b21` (file:line cited). Where a prior doc
  (e.g. `BENCHMARKS.md`) states something, it is re-derived or flagged.
- **No Postgres / Redis / Docker exists in this sandbox**, and the worker is
  **not deployed in production** (known fact). Therefore **no worker, queue,
  scheduler-tick, retry, crash-recovery, or load test was executed here**.
  Everything runtime-shaped is marked **NOT RUN** with the reason, and is
  instead grounded in (a) static execution-path tracing and (b) the installed
  BullMQ 6.7.7 source
  (`node_modules/.pnpm/bullmq@6.7.7_ioredis@6.0.0_supports-color@10.2.2_/node_modules/bullmq/dist/cjs`),
  whose Lua/JS I read directly for dedup, backoff and rate-limit behaviour.
- **What WAS executed here (evidence, not fabrication):**
  - Full unit suite: `pnpm vitest run` in `apps/web` — **196 passed / 196**
    (2026-11-23, ~72 s). Targeted subset re-run separately: `job-backoff`,
    `scheduler-plan`, `sync-engine`, `report`, `mailer`, `snapshot-ttl`,
    `health` — **46 passed / 46**.
  - `pnpm --filter @metricflock/worker typecheck` (`tsc --noEmit`) — **exit 0**.
  - WCAG contrast math for Phase 6 is in the Phase 6 doc, not here.
- **Severity:** P0 critical (blocks production) · P1 high · P2 medium ·
  P3 low. **Verification:** CONFIRMED = traced in current source (and, where
  stated, in installed BullMQ source); POTENTIAL = follows from the code but
  needs a live Redis/Postgres run to observe.

## Findings

### A-WRK-01 — P3 (downgraded from P1 on dynamic verification) — REFUTED as stated — Duplicate manual sync is a 409, not a silent no-op; no orphaned PENDING row

- **Where:** `apps/web/src/app/api/sync/route.ts:33` (jobId),
  `apps/worker/src/index.ts:190-205` (row update by `syncJobRowId`),
  BullMQ `commands/includes/handleDuplicatedJob.lua` (duplicate jobId returns
  the existing job; no new execution, no error).
- **Evidence:** the manual-sync route builds
  `jobId = \`${type}:${website.id}:${new Date().toISOString().slice(0, 13)}\``— one bucket per website+type+hour — then **creates a new`AnalyticsSyncJob` row (PENDING) first** and enqueues with that id.
  BullMQ dedupes on custom jobId: re-adding an existing id returns the
  existing job. Two consequences follow from the code, not from a guess:
  1. The second click returns `{ status: "ok", queued: true }` and the UI
     (`SyncNowForm`) shows "Queued.", but **no new sync runs** — worse, if
     the first job already _completed_, it is still retained
     (`removeOnComplete: 100` for non-realtime queues,
     `packages/jobs/src/queue.ts:78`), so the duplicate add still resolves
     to the finished job.
  2. The worker updates the row named by the **existing job's**
     `syncJobRowId` (the first row). The second row is never referenced by
     any job, so it stays **PENDING forever** (nothing ever transitions it;
     the scheduler's 30-day prune only deletes SUCCEEDED/FAILED rows).
- **Reproduction (NOT RUN live — no Redis):** with worker+Redis up, click
  "Sync now" twice for the same website+type inside one UTC hour; observe
  the second response is `ok`, only one sync runs, and a second PENDING row
  appears on `/sync` that never resolves.
- **Dynamic verification 2026-11-23 (retry, real DB + local app server, scratch org A; no Redis): REFUTED — the finding's mechanism missed a constraint.** The route sets `externalId: jobId` on the row, and `AnalyticsSyncJob.externalId` is **`@unique`** (`schema.prisma:502`). Firing the same manual sync twice in one hour: first call → **503 `queue_unavailable`** (no Redis; row correctly marked FAILED, `lastError: "Redis unavailable — sync could not be queued"`), second call → **409 `{"error":"conflict"}`** (P2002 on the unique `externalId`), and only **one** row exists — FAILED, not an orphaned PENDING row. The same unique constraint fires before `enqueue()` in the with-Redis path too, so the predicted "second click returns ok + orphaned PENDING row" cannot happen; the duplicate is rejected at the DB layer. What remains true: a re-sync within the same hour is impossible and the client gets a generic 409 instead of a typed `already_queued` response (see A-API-06, P2, which already documents this). The with-Redis duplicate path was not executed (no Redis in sandbox) — the refutation rests on the DB constraint, which applies identically with Redis up. **Severity downgraded P1 → P3** (UX wording of a correctly-rejected duplicate).
- **Impact:** users are misled that a re-sync is running; the Sync-jobs page
  accumulates permanently-stuck PENDING rows, which also corrupts any
  "pending job" counts and erodes trust in the DLQ view.
- **Correction:** make manual jobIds unique per request while keeping the
  3-part colon rule, e.g. `` `${type}:${row.id}:${Date.now()}` `` (the row id
  is created first, so it is available), or check for a live job with that
  id before creating the row and return `409 already_queued` with the
  existing row id. Do not keep the hour bucket for manual syncs.
- **Regression test:** unit test on the route (mocked queue) asserting two
  successive manual syncs produce two distinct jobIds and two rows that
  both reach a terminal state; plus a Redis-backed test asserting the
  second enqueue actually executes.

### A-WRK-02 — P1 — CONFIRMED — Dead-letter view and requeue API are not tenant-scoped (cross-org read + requeue)

- **Where:** `apps/web/src/app/(app)/sync/page.tsx:25-40` (both queries),
  `apps/web/src/app/api/sync/failed/route.ts:14-27`,
  `apps/web/src/app/api/sync/requeue/route.ts:20-30`.
- **Evidence:** all three read `AnalyticsSyncJob` by `status: "FAILED"` (or
  by id) with **no `organizationId` filter and no join through
  `website.organizationId`**. The only org check in the requeue route is
  the _audit write_ (`organizationId: auth.user.organizationId`,
  line 41) — the row lookup at line 20 is unscoped. Any `SUPER_ADMIN` of
  any organisation can therefore list every organisation's failed jobs
  (websiteId, type, attempts, `lastError`, retained `payload`) and requeue
  another org's job, which the worker then executes against that org's
  website (`runJob` resolves everything from `websiteId`).
  Contrast with the audit-log page (`audit/page.tsx:16`, scoped by
  `organizationId`) and the manual-sync route (`api/sync/route.ts`,
  `assertWebsiteAccess`) — the DLQ surfaces are the outlier.
- **Reproduction (NOT RUN live — needs two orgs + a failed job):** as Org A
  SUPER_ADMIN, `GET /api/sync/failed` after Org B has a FAILED job; the
  response contains Org B's rows. Then `POST /api/sync/requeue` with Org B's
  row id returns `ok`.
- **Dynamic verification 2026-11-23 (retry, real DB + local app server, scratch orgs A/B): CONFIRMED-BY-EXECUTION.** Org A's SUPER_ADMIN listed org B's FAILED job via `GET /api/sync/failed` (payload included) and `GET /api/metrics` counted it (`dlq.failed24h: 1`); `POST /api/sync/requeue` with B's job id located the foreign row and reached `enqueue()`, returning `queue_unavailable` (503) only for lack of Redis — no authorization check stands between a foreign SUPER_ADMIN and the requeue. See A-SEC-01 for the full executed evidence. (Same finding as A-SEC-01; counts once in the unique total.)
- **Impact:** cross-tenant data disclosure and cross-tenant job execution —
  a tenant-isolation failure in a multi-tenant product. (Payloads here are
  small — `{ websiteId, manual }` — but `lastError` and website identity
  still leak, and requeue is an action, not just a read.)
- **Correction:** scope all three queries through the website:
  `where: { status: "FAILED", website: { organizationId } }` (and the same
  for the "recent jobs" query and the requeue `findUnique` — fetch with the
  org filter and return 404 otherwise). Add a tenant-isolation unit/integration
  test in the style of `apps/web/tests/unit/tenant-isolation.test.ts`.
- **Regression test:** two-org fixture asserting Org A cannot list or
  requeue Org B's failed rows (API returns empty / 404).

### A-WRK-03 — P1 — CONFIRMED — Weekly-report send loop is not per-recipient fault-isolated; a mid-loop failure duplicates mail on retry

- **Where:** `apps/worker/src/report.ts:104-112`.
- **Evidence:**
  ```ts
  let sent = 0;
  for (const to of recipients) {
    await sendMail({ to, subject, text });
    sent += 1;
  }
  await prisma.reportSchedule.updateMany({ where: { organizationId }, data: { lastSentAt: new Date() } });
  ```
  `sendMail` in SMTP mode awaits `transporter.sendMail` and **throws** on
  transport failure (`packages/auth/src/mailer.ts:64-70`). If recipient #2
  of 4 fails, recipients already mailed keep their copy, `lastSentAt` is
  never written, the BullMQ job throws and retries (5 attempts, jittered
  backoff) — and every retry re-mails recipients #1… until it fails again.
  Worst case: 5 attempts × earlier recipients receive up to 5 copies.
  There is no per-recipient try/catch, no sent-recipient record, and no
  idempotency key on the mail.
- **Reproduction (NOT RUN live — needs SMTP + a failing recipient):**
  configure a schedule with 2 recipients, make the 2nd address fail at
  SMTP level, run `sendOrgReport`; observe recipient #1 receives the report
  once per attempt.
- **Impact:** duplicate weekly reports to admins on any transient SMTP
  failure; the failure mode is the common one (one bad address blocks the
  whole org's report).
- **Correction:** wrap each `sendMail` in try/catch, collect per-recipient
  outcomes, continue past failures, update `lastSentAt` when at least one
  delivery succeeded, and return `detail` naming failed recipients (job
  succeeds with partial failure recorded, instead of throwing). Validate
  recipient addresses at schedule-save time so one bad address cannot sink
  the send.
- **Regression test:** unit test with a mocked `sendMail` that throws for
  the 2nd recipient: assert recipient #1 is mailed exactly once across the
  call, `lastSentAt` is set, and the result reports the failure.

### A-WRK-04 — P2 — CONFIRMED — Scheduler lock TTL (55 s) is shorter than an unbounded tick; a slow tick lets a second instance double-schedule · FIXED 2026-11-24

- **Verification 2026-11-24:** fixed in `apps/worker/src/scheduler.ts` — the tick now renews the lock while it runs (heartbeat every 20 s, atomic check-and-`PEXPIRE` Lua so a lock we no longer own is never extended), and a watchdog aborts the tick at the next phase boundary if it runs past 120 s (`scheduler.tick_timeout` counter). A lost lock aborts the tick instead of running alongside the instance that took it (`scheduler.lock_lost` counter); a failed renewal (Redis error) does not abort — an unreachable Redis cannot hand the lock to another instance either (`scheduler.lock_renew_failed` counter). Tick duration is recorded as the `scheduler.tick_duration_ms` sum counter plus a `tick completed` log line. The 55 s TTL is kept deliberately: a crashed worker stops renewing, so its lock still frees within ~55 s. `runTick` takes an optional `AbortSignal` and checks it at nine phase boundaries (after the website scan, after the last-success lookup, before/after the bulk enqueue, before the stale-job rule and each prune/sweep). The A-DB-05 shell-org sweep and the A-DB-10 `pruneInBatches` + stale-`RUNNING` rule in the same file are untouched (the batched prunes already cover that half of the finding's correction). Regression tests in `worker-scheduler.test.ts` (6 new: TTL-simulating fake Redis proves a second instance's `SET NX` fails at 60 s into a 70 s tick; lock-lost abort before enqueue; 120 s watchdog abort; failed renewal does not abort; duration recorded; a throwing scan still surfaces as `scheduler.tick_failed`; 5 fail without the fix — the scan-throw test pins the preserved error path).

- **Where:** `apps/worker/src/scheduler.ts:17-19` (`LOCK_TTL_MS = 55_000`,
  `TICK_MS = 60_000`), `runTick()` (paged website scan, unscoped groupBy,
  `enqueueBulk`, four prune `deleteMany`s — none time-bounded).
- **Evidence:** the lock is a plain `SET NX PX 55000` with no renewal or
  heartbeat, and `runTick` has no timeout. At 10k sites the tick does a
  500-row paged scan of all mapped websites, a full-table 30-day groupBy
  (A-WRK-05), one `addBulk` per queue, and four prune deletes — including
  an **unbatched** audit-log `deleteMany` over up to 365 days of rows and
  an unbatched analytics-cache prune. If that exceeds 55 s, the lock
  expires while the first tick is still running and a second worker
  instance acquires it and runs a second tick. Mitigating factor (verified):
  every scheduler-enqueued jobId is stable/bucketed, so the double tick
  mostly wastes work rather than double-executing syncs — but the prune
  deletes run twice, logs double-count, and the `submitted` counts are
  wrong. The in-process `tickRunning` guard (line 33) only protects one
  process, not two instances.
- **Impact:** duplicate scheduling work and misleading logs/metrics at
  scale; the exact failure it was designed to prevent (double-enqueue)
  reappears through the TTL gap.
- **Correction:** renew/extend the lock while the tick runs (or set TTL
  comfortably above the worst observed tick and alert on tick duration),
  and/or bound the tick (batch the audit/cache prunes, add a tick timeout
  with a `scheduler.tick_timeout` counter). Record tick duration as a
  metric.
- **Regression test:** integration test with a short TTL and an artificially
  slow `runTick` asserting only one instance enqueues; plus a unit test
  that prune deletes are batched.

### A-WRK-05 — P2 — CONFIRMED — Scheduler's last-success lookup is an unscoped full-table groupBy run every minute · FIXED 2026-11-24

- **Verification 2026-11-24:** fixed in `apps/worker/src/scheduler.ts` — the last-success groupBy is now scoped per website page: it runs inside the existing page-windowed website scan with `websiteId: { in: pageIds }` (at most 500 ids per call), served by the `@@index([websiteId, type, status, updatedAt])` index, instead of one unscoped groupBy over every SUCCEEDED row in 30 days on every tick. The 30-day window is unchanged. `planDueSyncs` only looks up `lastSucceededAt` for websites in the loaded list, so the due decision is identical — rows for other websites were never read. The groupBy is skipped entirely on ticks with no mapped websites (the old code issued the full-table aggregation even then). No materialised column was added (no schema change, no migration): the per-page IN-list query is the shape the benchmark script already measures as "last-sync groupBy (page ids)", so A-WRK-12's benchmark run can compare it directly against the old "scheduler: last-success groupBy (30d window)" — the benchmark measurement itself is still pending A-WRK-12 (needs a real DB, owner approval). The A-DB-05 shell-org sweep, A-DB-10 `pruneInBatches` + stale-`RUNNING` rule, and A-WRK-04 lock heartbeat/watchdog in the same file are untouched. Regression tests in new `scheduler-last-success-scope.test.ts` (4 new: groupBy scoped to the page's ids with the 30-day window and no unscoped call; same due set as the unscoped lookup on seeded fixtures, including an unrelated website's row having no effect; one scoped groupBy per page across pages; no groupBy at all with no mapped websites; all 4 fail without the fix).

- **Where:** `apps/worker/src/scheduler.ts:84-93`.
- **Evidence:** `prisma.analyticsSyncJob.groupBy({ by: ["websiteId","type"],
where: { status: "SUCCEEDED", websiteId: { not: null },
updatedAt: { gte: windowStart } }, _max: { updatedAt: true } })` — no
  website, organisation or time-bucket scoping beyond a 30-day window, and
  it runs on **every tick (every 60 s)**. The index
  `@@index([websiteId, type, status, updatedAt])`
  (`packages/db/prisma/schema.prisma:510`) can serve the `status`/`updatedAt`
  filter only partially; the groupBy still reads every org's successful
  rows for 30 days. At 10k sites × ~6 sync types × hourly/daily successes
  this is a large aggregation per minute. The benchmark script measures
  this exact query (`benchmark-scale.ts`, "scheduler: last-success groupBy")
  — but it has never been run against a real database (A-WRK-12), so the
  cost is unmeasured.
- **Impact:** scheduler tick latency grows with total portfolio history, not
  with due work; risks A-WRK-04 lock expiry and Redis/DB load at scale.
- **Correction:** scope the lookup (per-website last-success via the
  existing page-windowed query, or a materialised `lastSucceededAt` on the
  website/integration row updated by the worker), or run it less often
  than every tick with a cached map. Measure it with the benchmark script
  before choosing.
- **Regression test:** benchmark run at 1k/10k (A-WRK-12) with a tick-time
  budget assertion.

### A-WRK-06 — P2 — CONFIRMED — Weekly report has a 1-hour send window and no catch-up; a missed hour loses a whole week · FIXED 2026-11-24

- **Verification 2026-11-24:** fixed with a new `getReportDueKind` in `packages/shared/src/report.ts` (`isReportDue` is now `getReportDueKind(...) !== null`, so all existing due/not-due tests still pass): a schedule whose last send is at least 7 days old is due as a "catch-up" on the next tick regardless of the configured weekday/hour, so a missed send hour no longer loses a whole week. A schedule that was never sent is NOT a catch-up (it waits for its first window instead of firing within a minute of being created), and when both apply — stale send, and right now is the configured window — the window wins, so an on-time send is never counted as a missed one. The scheduler (`apps/worker/src/scheduler.ts`, report section only) emits `scheduler.report_missed` plus a warning log when a catch-up fires. The one-send cap: the dayBucket jobId dedupes repeat ticks within the day, and the report job records `lastSentAt` once ≥ 1 recipient is mailed, so the schedule stops being due; a fully-failed job exhausts its BullMQ retries (5 attempts) within ~15 minutes, so at most one live catch-up job exists at a time. Residual: if a catch-up job somehow sat unprocessed across midnight (queue stalled for hours while the scheduler kept ticking), the next day's tick could enqueue a second job with the new dayBucket id and both could send — closing that needs a due-ness re-check inside `sendOrgReport`, flagged as a follow-up. The A-DB-05 sweep, A-DB-10 prune/stale rules, A-WRK-04 heartbeat/watchdog, and A-WRK-05 scoped groupBy in the same file are untouched. Regression tests in `report.test.ts` (5 new: catch-up outside the window, exact 7-day boundary, never-sent is not a catch-up, window precedence, disabled never due) and new `scheduler-report-catchup.test.ts` (3 tests: missed report enqueued + counter, never-sent not a catch-up, repeat ticks reuse the same dayBucket jobId; 4 of the 8 fail without the fix).

- **Where:** `packages/shared/src/report.ts:79-91` (`isReportDue`),
  `apps/worker/src/scheduler.ts:156-166`.
- **Evidence:** `isReportDue` requires `now.getUTCDay() === dayOfWeek`
  **and** `now.getUTCHours() === hourUtc`, plus no send in the last 6 days.
  The scheduler only evaluates it during ticks inside that hour. If the
  worker is down, Redis is down, the lock is held by another instance, or
  a tick runs long across the hour boundary, the report is not due again
  until the same weekday/hour **next week** — there is no missed-send
  detection, no catch-up run, and no alert. (Unit tests in
  `apps/web/tests/unit/report.test.ts:36-47` cover the due/not-due logic
  itself — the gap is the absence of any catch-up path, which no test
  covers.)
- **Impact:** silent loss of a scheduled customer-facing report for a week,
  with no signal to anyone.
- **Correction:** add a catch-up rule (e.g. due if enabled and
  `lastSentAt` is older than 7 days, regardless of hour, capped to one
  catch-up send), and emit a log/counter (`scheduler.report_missed`) when
  a due hour passes with no successful send.
- **Regression test:** unit tests for `isReportDue` with a stale
  `lastSentAt` outside the configured hour; scheduler test asserting a
  missed report is enqueued on the next tick.

### A-WRK-07 — P2 — CONFIRMED — `cache-refresh` and `ga4-historical` have no per-provider / per-report isolation; one failure aborts the rest and retries redo finished work · FIXED 2026-11-24

- **Where:** `packages/google/src/sync.ts:263-279` (`cache-refresh` loop),
  `sync.ts:196-214` (`syncOneProvider` report loop).
- **Evidence:** `cache-refresh` loops `["ga4-historical",
"search-console", "adsense", "ad-manager"]` sequentially with no
  try/catch per kind — a Search Console throw means AdSense/Ad Manager are
  never refreshed that run, the job is FAILED, and the retry re-fetches
  GA4 too. Likewise `ga4-historical` loops 5 reports; a failure on report
  3 leaves reports 1–2 cached but the job FAILED, and the retry refetches
  all 5 (wasted Google quota). The error contract at the top of `sync.ts`
  (throw = retryable) is honoured, but partial progress is neither
  recorded nor resumed. Test coverage (`sync-engine.test.ts:183`,
  "cache-refresh warms every mapped provider") uses all-success fakes —
  no partial-failure case exists.
- **Impact:** wasted Google quota and slower recovery; a single flaky
  provider degrades every other provider's freshness for that website.
- **Correction:** try/catch per provider (and per report), record health
  per provider, return `ok` with a `detail` listing failed providers when
  at least one succeeded; only throw (retry) when _all_ providers fail or
  the failure is rate-limit/quota shaped.
- **Regression test:** sync-engine test with a failing 2nd provider
  asserting later providers still run and the result reports partial
  failure.
- **Verification 2026-11-24:** revalidation first — the `cache-refresh` half was already covered by A-GGL-12 (per-provider try/catch in `syncWebsite`, aggregate `partial` when some warmed, throw when nothing warmed), so no change was made there except surfacing a provider-level `partial` in the aggregate detail. The remaining gap was the report loop inside `syncOneProvider` (`packages/google/src/sync.ts`): one try/catch around all 5 `ga4-historical` reports, so a failure on report 3 aborted reports 4–5, failed the whole job, and the BullMQ retry refetched all 5. The loop is now per-report: a failed report records error health (best-effort, so a failing health write cannot abort the remaining reports) and the loop continues; when at least one report warmed, the result is `partial` with the failed reports in `detail` (the job SUCCEEDS, so no retry refetches the warmed reports); only when every report failed, or the failure is rate-limit/quota shaped, does the sync throw — a quota error (`quota`/`rateLimitExceeded`/`RESOURCE_EXHAUSTED` message, gRPC code 8, or HTTP 429, mirroring the web layer's `classifyAnalyticsError` plus the 429 status googleapis carries) aborts the loop immediately, because the API is telling us to back off, not to burn more quota on the remaining reports. Single-report kinds are behavior-identical (their one failure is an all-failed throw). On a partial result the error health stands (no `ok` record overwrites it). A-GGL-04 (`SCOPE_MISSING` → skipped), A-DB-12 (`LEGACY_CONNECTION_MISSING` → terminal `no_mapping`), A-GGL-07 (SC clamp), A-GGL-11 (health-check `partial`), A-GGL-12 (cache-refresh partial/throw split), and A-GGL-13 (discovery isolation) in the same file are untouched. Regression tests in new `sync-per-report-isolation.test.ts` (6 tests: failing 2nd report → later reports still run, `partial` with the failed report in `detail`; all reports failing → throws the first error; quota-shaped failure mid-loop aborts and throws with only the earlier reports cached; 429-coded error is quota-shaped; `cache-refresh` surfaces a provider `partial` in the aggregate detail; single-report kind failing still throws — 5 of the 8 new/updated tests fail without the fix; the quota and single-report tests pin preserved behavior and pass against the old code too). Two existing tests in `google-sync-extra.test.ts` were updated to the new contract (mid-loop failure, non-Error thrown mid-fetch). Note: the `throwGa4` helper in `sync-cache-refresh.test.ts` (an A-GGL-12 file) was updated so all five GA4 report fns throw — under per-report isolation, failing only the overview report no longer models "GA4 is down" (the other four would still warm and return `partial`), so the two "nothing warmed + a throw" tests in that file now fail all five reports to keep their original intent and assertions; no test assertion in that file was changed.

### A-WRK-08 — P2 — CONFIRMED — `healthCheckWebsite` early-returns on the first provider failure, so remaining providers go unchecked · FIXED 2026-11-24

- **Where:** `packages/google/src/sync.ts:282-316`.
- **Evidence:** the provider loop returns immediately on
  `CONNECTION_REQUIRED` and on any `TOKEN_ERRORS` member (after recording
  error for _that_ provider only). Providers later in the fixed order
  `["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"]` are never checked
  that run, so their health rows go stale and no `recovered`/`alert_error`
  transition is computed for them. A non-token error throws out of the
  loop and fails the whole health-check job. Note the loop also sets
  `anyConnected` only on the success path, so the
  `!checked.length && !anyConnected` → `no_mapping` branch is only
  reachable when every mapped provider errors in a non-early-return way.
- **Impact:** incomplete health picture; a revoked GA4 connection masks a
  simultaneously-failing AdSense connection for an hour or more.
- **Correction:** collect per-provider outcomes, continue past failures,
  record health for every mapped provider, and return `ok` with
  `reports: checked` plus a `detail` of failures (throw only if no provider
  could be checked at all).
- **Regression test:** health-check test with GA4 revoked + AdSense healthy
  asserting both providers get a health row.

  _Verification (2026-11-24): fixed in `packages/google/src/sync.ts`
  (`healthCheckWebsite` only). The CONNECTION_REQUIRED half was already
  covered by A-GGL-11; the remaining gap was the token-error early-return
  (`skipped` on the first token error) and the generic-error `throw`, both
  of which aborted the check. Per-provider failures are now collected and
  the loop always continues: a token error records error/`needs_reauth`
  health, a generic error records error health and is remembered. The
  aggregate is `partial` (reports: checked, detail lists every failure)
  when some providers checked ok, `skipped` when nothing checked ok and
  every failure is a permanent auth failure, `not_connected` when none is
  connected, and `no_mapping` when nothing is mapped; only when no
  provider could be checked at all because of a generic error does the
  check throw (BullMQ retries). `partial`, not the finding's literal
  `ok` with a detail, so the worker keeps the failure in the job row's
  `lastError` instead of nulling it (A-GGL-11/A-WRK-07 precedent). The
  LEGACY branch is deliberately untracked in the aggregate (A-DB-12's
  `no_mapping` contract: a legacy mapping is "unmappable", not a
  provider failure). Regression tests in new
  `health-check-isolation.test.ts` (7 tests) + 2 updated tests in
  `google-sync-extra.test.ts` and 1 updated test in `sync-engine.test.ts`
  (the SCOPE_MISSING detail now lists every failed provider, and its
  health assertion covers all three providers); 9 of the 10 new/updated
  tests fail against the old code (the legacy test pins the preserved
  A-DB-12 contract). A-GGL-04/A-DB-12/A-GGL-07/A-GGL-11/A-GGL-12/A-GGL-13/
  A-WRK-07 in the same file verified intact._

### A-WRK-09 — P2 — CONFIRMED — Scheduler syncs websites of any status, including ARCHIVED / SOLD / TRANSFER_PENDING · FIXED 2026-11-24

- **Verification:** the scan in `apps/worker/src/scheduler.ts` now filters `status: { in: ["ACTIVE", "PENDING_SETUP"] }` alongside the MAPPED-integration filter; no status is threaded through `planDueSyncs` (it only ever sees the filtered page). DISCONNECTED is excluded deliberately: its connection is gone, so every sync would only re-record `not_connected` health; reactivation is a manual status flip in the website actions UI (the map route only auto-flips PENDING_SETUP → ACTIVE and leaves manually set states alone). TRANSFER_PENDING is excluded (mid-transfer; A-DB-04 freezes team/status changes for the open-transfer window); SOLD/ARCHIVED are retired. Mappings are NOT unmapped or auto-paused — they stay intact so a site can be reactivated by a status flip without re-discovery. Regression tests in new `scheduler-status-filter.test.ts` (8 tests; 6 fail without the fix — the ACTIVE/PENDING_SETUP "gets jobs" tests pin preserved behavior). The faithful `website.findMany` mock applies the scan's `where` to the fixtures the way Postgres would. Benchmark note: the A-WRK-12 evidence below still says the benchmark's scan filters `status: "ACTIVE"` — that is now only a PENDING_SETUP-wide divergence from production, not a missing filter.

- **Where:** `apps/worker/src/scheduler.ts:58-66`.
- **Evidence:** the website scan filters only on
  `integrations: { some: { mappingStatus: "MAPPED" } }` — there is no
  `status` filter, although `WebsiteStatus` has `ACTIVE, PENDING_SETUP,
DISCONNECTED, TRANSFER_PENDING, SOLD, ARCHIVED`
  (`packages/db/prisma/schema.prisma:15-22`). A sold or archived website
  with a still-mapped property keeps being synced every interval, burning
  Google quota and capable of generating health-failure alert emails for a
  site the user retired. The benchmark script's scan query _does_ filter
  `status: "ACTIVE"` (`benchmark-scale.ts`, "scheduler: website page scan")
  — i.e. the benchmark does not measure the production query (see
  A-WRK-12).
- **Impact:** wasted quota + noise alerts on retired sites; at portfolio
  scale, dead sites are a permanent tax on every tick.
- **Correction:** add `status: { in: ["ACTIVE", "PENDING_SETUP"] }` (decide
  explicitly whether DISCONNECTED sites should be health-checked) to the
  scheduler scan; consider unmapping or auto-pausing sync on ARCHIVED/SOLD.
- **Regression test:** scheduler-plan test with an ARCHIVED website in the
  fixture asserting no jobs are planned for it (requires threading status
  through `planDueSyncs` or the scan query).

### A-WRK-10 — P2 — CONFIRMED — Weekly report (and portfolio totals) silently truncate at 200 websites · FIXED 2026-11-24

- **Verification (2026-11-24):** fixed by paginating instead of capping. `sendOrgReport` (`apps/worker/src/report.ts`) now pages `website.findMany` in pages of 200 (createdAt asc, `skip`/`take`) and, per page per section, reads primaries + snapshots through the A-DB-11 batch helpers (`getPrimaryIntegrations` + `readSnapshots`) — the old code did 2N per-website round-trips per section on top of the cap. `loadPortfolio` (`apps/web/src/lib/portfolio.ts`) pages the website list the same way (200 per page, one batched primaries + one batched snapshots call per page); with no explicit `limit` the totals cover every website and `truncated` is false. An explicit `limit` keeps the old capped behavior (one page, totals over that page, `truncated` when the cap bites) — no caller passes one today. The A-GGL-07 SC clamp is preserved in both files (report's SC section still reads the clamped key; portfolio still builds SC keys from the clamped range), as are the A-DB-11 batch semantics (failed batch → affected websites unavailable, never fatal) and the A-WRK-03 per-recipient isolation + `lastSentAt` rule in the worker. The dashboard needs no change: `pfGa4.websites.length` is now the true included count, and the top-10-by-sessions table is now computed across the whole org instead of the first 200. Query counts for a 500-site org: worker report 3 findMany pages + 18 batch calls (3 sections × 3 pages × 2) instead of 1 findMany + ~3,000 per-website calls; `loadPortfolio` 1 count + 3 findMany + 3 primaries + 3 snapshots = 10 Prisma-issuing calls (was 4 with the cap); ≤200-site orgs are unchanged at 4 calls, so the A-DB-11 `loaders-query-count` assertions still pass. Regression tests in new `report-truncation.test.ts` (2 tests: 250-site fixtures for the worker report — "Sessions: 2,500", 2 pages — and for `loadPortfolio` — 250,000 sessions, 250 entries, `truncated: false`; both fail against the old cap). Residual (same bug class, different loader, not in this finding's Where list): `loadInsights` (`apps/web/src/lib/insights.ts`) still caps its summary totals at the first 200 websites (`PORTFOLIO_WEBSITES`) — follow-up.
- **Where:** `apps/worker/src/report.ts:36-41` (`take: 200`),
  `apps/web/src/lib/portfolio.ts:51,61` (default `limit = 200`).
- **Evidence:** `sendOrgReport` loads `take: 200` websites ordered by
  creation date and builds all three sections from those only. Nothing in
  `buildReportEmail` (`packages/shared/src/report.ts:40-72`) mentions a
  cap, and the email's "N websites with data" counts only the included
  ones — an org with 500 sites gets a report that silently omits 300 of
  them, with totals that look complete. The dashboard has the same silent
  cap (`loadPortfolio` default 200; the dashboard shows "N websites
  included" but never the org total beside it).
- **Impact:** wrong portfolio totals in the flagship weekly email for any
  org over 200 sites — the exact audience (100+ site portfolios) this
  product targets.
- **Correction:** paginate the website load in `sendOrgReport` (and
  `loadPortfolio`) instead of capping, or — if a cap must stay — include
  the org's website count and an explicit "showing first 200 of N" note in
  the email and dashboard.
- **Regression test:** report test with a >200-website fixture asserting
  totals include all sites (or the truncation note appears).

### A-WRK-11 — P2 — CONFIRMED — No crash handlers, no shutdown timeout, in-flight tick not awaited · FIXED 2026-11-24

- **Verification (2026-11-24):** fixed in `apps/worker/src/index.ts` + `apps/worker/src/scheduler.ts`. `uncaughtException`/`unhandledRejection` handlers are registered at startup (exported as `handleUncaughtException`/`handleUnhandledRejection` so tests can invoke them directly); each logs the error and exits 1 so the host restarts cleanly instead of crashing silently with only Node's default output. `startScheduler` now tracks the in-flight tick and `stop()` is async — it clears the interval and awaits the tick, so a running tick cannot keep enqueueing while the workers close. Shutdown awaits `scheduler.stop()`, then awaits the health-server close, then bounds the worker drain: `Worker.close()` waits for in-flight jobs, and after `SHUTDOWN_TIMEOUT_MS` the workers are force-closed with `close(true)` instead of being SIGKILLed mid-job; `prisma.$disconnect()` is awaited and the (synchronous) ioredis `disconnect()` runs before `process.exit(0)`. The timeout default is 8 s (`WORKER_SHUTDOWN_TIMEOUT_MS` env override) — the finding's suggested 25 s would be SIGKILLed before it ever fired: Docker `stop` defaults to 10 s, and Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to 0 (Railway docs, Deployment Teardown), so on Railway the owner must set the draining seconds in the service settings for graceful shutdown to have any window at all; 8 s leaves 2 s headroom inside Docker's 10 s default and fits inside a 30 s Railway draining window. Regression tests in new `worker-shutdown.test.ts` (4 tests: crash handlers log + exit 1; slow in-flight job exits within the timeout — 368 ms observed with a 200 ms test timeout — and force-closes; stop() awaited before any worker closes) + new `worker-scheduler-stop.test.ts` (2 tests: stop() pending while a tick is in flight, resolves when it finishes; resolves immediately with no tick running); all 6 fail against the old code. The existing `worker-index.test.ts` fast-path shutdown test (26 tests) and `worker-scheduler.test.ts` (26 tests) pass unedited.

- **Where:** `apps/worker/src/index.ts:335-351` (shutdown),
  `apps/worker/src/index.ts:1-40` (no `unhandledRejection` /
  `uncaughtException` handlers anywhere in the file).
- **Evidence:** the process listens only for `SIGTERM`/`SIGINT`. An
  unhandled rejection (e.g. a stray Prisma/Redis promise rejection in a
  processor path) crashes the whole process — all 10 queue workers at
  once — with no log line beyond Node's default. Shutdown does
  `await Promise.allSettled(workers.map((w) => w.close()))` with **no
  timeout**: `Worker.close()` waits for in-flight jobs, so a slow Google
  call can hold shutdown past the orchestrator's kill grace period
  (Docker `stop` default 10 s; the Dockerfile's HEALTHCHECK implies a
  container host) and the process is then SIGKILLed mid-job — the exact
  "stalled redelivery and duplicate side effects" the OPS-5 comment says
  shutdown exists to prevent. Also: `scheduler.stop()` only clears the
  interval — a tick already running keeps enqueueing while workers close;
  `healthServer.close()` is not awaited; `redisClient.disconnect()` is not
  awaited before `process.exit(0)`.
- **Impact:** crash takes down all queues; unclean shutdown can duplicate
  side effects (snapshot upserts are idempotent, but report sends and
  alert emails are not — see A-WRK-03).
- **Correction:** add `unhandledRejection`/`uncaughtException` handlers
  that log and exit non-zero (letting the host restart cleanly); bound
  shutdown with a timeout that force-closes workers after e.g. 25 s; make
  `stop()` await an in-flight tick (track the tick promise); await the
  health-server close and Redis disconnect.
- **Regression test:** shutdown test with a slow in-flight job asserting
  the process exits within the timeout; a test asserting a rejected
  promise in a processor is logged (not silent).

### A-WRK-12 — P2 — CONFIRMED — Scale-benchmark DB timings were never run, and the script does not measure the production queries · FIXED 2026-11-24 (script aligned; first real-DB run still pending owner approval)

- **Where:** `docs/audit/BENCHMARKS.md` ("Results — Not yet run against a
  real database — sandbox has no Postgres. First run pending"),
  `packages/db/scripts/benchmark-scale.ts`.
- **Evidence (revalidated, not trusted from the doc):**
  - The doc's headline numbers (100/1k/10k, "345×" speedup) are a **JS
    in-memory** comparison of an old O(W×I) scan vs a single-pass — a shape
    the dashboard no longer uses (it now issues a `COUNT` with a relation
    filter). The numbers are real arithmetic but say nothing about
    production latency.
  - The script itself has real methodology gaps vs production:
    1. Its "scheduler: website page scan" filters `status: "ACTIVE"`; the
       production tick filters `status: { in: ["ACTIVE", "PENDING_SETUP"] }`
       alongside the mapped-integration filter (A-WRK-09, fixed 2026-11-24)
       — the remaining divergence is PENDING_SETUP sites only.
    2. It seeds **only GA4** integrations, one team, no FAILED/RETRYING
       rows, no audit-log or analytics-cache rows — so the prune deletes
       and the DLQ queries are unmeasured.
    3. It times Prisma queries only. It never measures `enqueueBulk`/Redis
       round trips, worker throughput, limiter behaviour, or Google API
       latency — the actual scale bottlenecks.
    4. Seed + cascade-delete cost for 10k sites is unmeasured (the
       `finally` delete is outside any timer).
  - Safety rails in the script are genuinely good and were verified:
    refuses without `BENCH_CONFIRM=1`; refuses a `prisma.io` (production)
    URL without `BENCH_ALLOW_PROD=1`.
- **Impact:** the "no uncontrolled fan-out at 100–10k" verdict in
  `BENCHMARKS.md` rests on an in-memory JS micro-benchmark, not on
  measured database behaviour. It must not be cited as scale evidence.
- **Correction:** run the script against staging/local Postgres at
  100/1k/10k, record dated results in `BENCHMARKS.md`; fix the scan query
  to match production; add FAILED-row and audit/cache seeding; add a
  Redis/worker-throughput measurement (jobs enqueued + processed per
  minute at 1k sites).
- **Regression test:** N/A (benchmark); gate the v2.0.0 scale claim on a
  recorded run.
- **Verification (2026-11-24):** the script + doc gaps are fixed; the
  run itself is still outstanding. `benchmark-scale.ts` now matches
  production exactly (A-WRK-09 page scan with `status: { in: ["ACTIVE",
"PENDING_SETUP"] }` + MAPPED-integration filter; A-WRK-05 per-page
  scoped last-success groupBy, 500 ids — the old unscoped variant is
  removed), seeds FAILED/RETRYING sync-job rows, audit-log rows (2 per
  website, first 1000 sites) and one analytics-cache snapshot per
  website, measures the DLQ FAILED count + page, the audit-log count +
  page, a 200-key cache read, the retention prune (A-DB-10 shape) and
  the stale-RUNNING rule, and times seed + cleanup (the audit rows are
  deleted before the org delete because `AuditLog.organization` is
  `onDelete: Restrict`). A new companion script,
  `apps/worker/scripts/bench-throughput.ts`, measures enqueue +
  drain throughput for the real `planDueSyncs` plan at 1k sites on a
  scratch queue with a no-op worker (production concurrency 5, no
  limiter — the drain rate is the BullMQ/Redis ceiling, not the
  rate-limited production rate, and Google API latency is excluded).
  `BENCHMARKS.md` now states plainly that the "345×" table is a JS
  in-memory micro-benchmark of a dashboard shape that no longer
  exists and must not be cited as scale evidence, and the
  "no uncontrolled fan-out" verdict is withdrawn to "not measured
  yet". **First real-DB run at 100/1k/10k still pending Gulzaib's
  explicit staging-DB approval** (owner-flagged); no benchmark was
  run against any database for this fix.

### A-WRK-13 — P3 — CONFIRMED — Backoff off-by-one: first retry is 60–120 s, and the 1 h cap is unreachable with 5 attempts · FIXED 2026-11-25

- **Where:** `packages/jobs/src/queue.ts:55-58` (`jitteredBackoffMs`),
  BullMQ `classes/job.js:458`
  (`Backoffs.calculate(opts.backoff, this.attemptsMade + 1, err, …)`).
- **Evidence:** BullMQ invokes the custom `backoffStrategy` with
  `attemptsMade + 1`, i.e. **1 on the first failure**, never 0. So the
  first retry delay is `jitteredBackoffMs(1)` = 60–120 s, not the 30–60 s
  the unit test asserts for input 0 (`job-backoff.test.ts:9-13` tests the
  pure function, not the BullMQ call site). With `attempts: 5` there are
  at most 4 retries, with bases 120 s, 240 s, 480 s, 960 s — the
  "capped at 1 h" branch (`queue.ts:56`) can never trigger. The
  `BENCHMARKS.md` claim "60s base, 1h cap" is therefore inaccurate in
  practice. Behaviour is safe (just slower first retry than documented).
- **Correction:** document the real schedule (first retry 60–120 s) or
  subtract 1 inside the strategy; either way, assert the _effective_
  schedule in a test that drives `Backoffs.calculate` the way BullMQ
  does.
- **Regression test:** test calling the strategy with BullMQ's 1-based
  argument and asserting the delay sequence.
- **Verification (2026-11-25):** the worker registration
  (`apps/worker/src/index.ts`) now subtracts 1 — `jitteredBackoffMs(attemptsMade - 1)` —
  so BullMQ's 1-based argument maps onto the function's 0-based retry
  index and the effective schedule matches the documented design:
  first retry 30–60 s (60 s base × 0.5–1.0 jitter), doubling per retry;
  with `attempts: 5` the bases are 60/120/240/480 s, so the 1 h cap
  remains a guard for a future attempts increase (unreachable today —
  now stated in the `queue.ts` comment and in `BENCHMARKS.md`).
  `worker-index.test.ts` now asserts the effective schedule through the
  registered strategy with BullMQ's 1-based calls (1 → [30 s, 60 s],
  2 → [60 s, 120 s], 4 → [240 s, 480 s]); pre-fix it failed
  (`expected 118249 to be less than or equal to 60000`). The pure
  function and its `job-backoff.test.ts` assertions are unchanged.

### A-WRK-14 — P3 — CONFIRMED — Rate-limit path writes a misleading RETRYING row and bypasses backoff/counters · FIXED 2026-11-25

- **Where:** `apps/worker/src/index.ts:215-223`,
  BullMQ `classes/worker.js:646-652` (`handleFailed` → `moveLimitedBackToWait`)
  and `classes/job.js:458`.
- **Evidence:** on `SyncRateLimitError` the worker updates the
  `AnalyticsSyncJob` row to `RETRYING`, then throws
  `Worker.RateLimitError()` (the static constructor exists —
  `worker.js:36-37`). BullMQ treats that error specially: the job is
  moved back to wait **without consuming an attempt, without running the
  custom backoff strategy, and without emitting the `failed` event**
  (so `worker.on("failed")` at `index.ts:257` never fires and
  `jobs.failed.*` is not incremented). The row therefore says RETRYING
  while the job is actually waiting under the queue limiter, and a
  rate-limit storm is invisible in the worker's failure counters. The
  next attempt corrects the row to RUNNING, so the inconsistency is
  transient — but during a Google quota event every rate-limited site
  shows RETRYING indefinitely.
- **Correction:** write the row as `RETRYING` only with a `lastError` that
  names the rate-limit delay, or introduce a distinct status/note; add a
  `jobs.ratelimited.*` counter in the `SyncRateLimitError` branch (before
  throwing) so the storm is visible on `/metrics`.
- **Regression test:** Redis-backed test asserting a rate-limited job's row
  state and counters after the throw.
- **Verification 2026-11-25 (fixed):** the `SyncRateLimitError` branch in
  `apps/worker/src/index.ts` now (a) writes the row with a note naming the
  actual state — `rate limited (per-connection quota); job waiting under
queue limiter (no attempt consumed)` — instead of the bare "job delayed",
  which read like a backoff retry (no distinct status was introduced: the
  `SyncJobStatus` enum has no rate-limited value and adding one needs a
  migration; RETRYING stays correct for the sync route's in-progress
  check), (b) increments `jobs.ratelimited.<queue>` before throwing, so the
  storm is visible on the worker's `/metrics` even though BullMQ emits no
  `failed` event for `RateLimitError`, and (c) logs a warn line with
  queue/jobId/websiteId. The BullMQ delay behavior itself is unchanged
  (the handled path per A-GGL-19). Regression test: the rate-limit test in
  `worker-index.test.ts` now asserts the row note, the
  `jobs.ratelimited.*` counter, and the warn log after the throw (all fail
  without the fix; the finding's Redis-backed variant is CI-only — no
  Redis in the sandbox).

### A-WRK-15 — P3 — CONFIRMED — Property discovery aborts entirely if one provider's list call throws · FIXED 2026-11-25

- **Where:** `packages/google/src/sync.ts:339-402`
  (`discoverConnectionProperties`).
- **Evidence:** the four provider listings run sequentially with no
  per-provider try/catch. If `listGa4Properties` throws (e.g. GA4 API
  disabled), Search Console and AdSense are never listed, the job fails,
  and the retry re-runs the whole discovery. The chunking itself is good
  (bounded parallel upserts, `CHUNK = 10`). Contrast with the _web_
  discovery route (`apps/web/src/app/api/google/properties/discover/route.ts`),
  which classifies per-provider errors and returns partial results — the
  worker path is strictly less robust than the UI path for the same
  operation.
- **Correction:** try/catch per provider, return counts for the providers
  that succeeded plus an errors map; only throw when no provider could be
  listed.
- **Regression test:** sync-engine discovery test with GA4 throwing,
  asserting SC/AdSense counts are still returned.
- **Verification 2026-11-25 (fixed):** the finding was mostly stale — the
  per-provider try/catch, the `errors` map, honest per-provider counts, and
  the guarded pruning were already in place from A-GGL-13
  (`discoverConnectionProperties` in `packages/google/src/sync.ts`, pinned
  by `sync-discovery-isolation.test.ts`). The one remaining gap was the
  all-fail case: when every provider's listing threw, the function returned
  all-zero counts + `errors` and the worker reported the discovery job "ok".
  It now tracks whether any provider's listing returned (zero items still
  counts as listed) and, when none did, throws the first error — the worker
  records FAILED and BullMQ retries with backoff, mirroring
  `syncOneProvider`'s all-failed contract; partial failures still return
  counts + `errors` (A-GGL-13 job-ok-with-errors-in-detail behavior
  unchanged). Regression tests in `sync-discovery-isolation.test.ts`:
  all listings throw → rejects (with and without Ad Manager enabled; both
  fail without the fix); one listing succeeds with zero items while the
  others throw → resolves with the errors map (control, passes before and
  after). Residual: listings succeeding but every upsert failing still
  returns counts + `errors` rather than throwing — the correction's
  criterion is listing-based.

### A-WRK-16 — P3 — CONFIRMED — Failure alerts have no aggregation; a provider outage emails per website per queue · FIXED 2026-11-25

- **Where:** `apps/worker/src/index.ts:40-62` (`alertSyncFailure`),
  `index.ts:64-96` (`alertHealthTransition`), `index.ts:107-127`
  (`alertingRecordHealth`).
- **Evidence:** the transition dedup is good — `healthTransition`
  (`packages/shared/src/health-state.ts:30-35`, unit-tested in
  `health.test.ts`) emails once per transition, not per check, and alert
  failures are caught and logged so they never mask the job error.
  But there is **no cross-website aggregation**: a Google outage that
  terminally fails 100 websites × several queues sends one email per
  (website, queue) to every org SUPER_ADMIN, sequentially, inside the job
  handler. No batching, no digest, no per-org rate cap.
- **Impact:** alert storm during exactly the incident when admins are
  already overloaded; sequential `sendMail` also extends job processing
  time.
- **Correction:** aggregate terminal failures per org over a short window
  (e.g. one digest email per org per 15 min listing affected sites), or
  cap alert emails per org per hour with a counter.
- **Regression test:** test with N failing websites asserting at most one
  email per org per window.
- **Verification (2026-11-25):** failure alerts are now capped per organization at one per 15-minute window (`ALERT_WINDOW_MS` in `apps/worker/src/index.ts`, via the shared Redis-backed `rateLimit` with key `alert:<orgId>`, limit 1). The gate covers terminal sync failures (`alertSyncFailure`) and health `alert_error` transitions (`alertHealthTransition`); suppressed alerts increment `alerts.suppressed` (/metrics) and are warn-logged instead of emailed. The first failure in a window still alerts immediately, so an isolated failure is never delayed; recovery emails are not gated. The limiter is deliberately not `failClosed`: on a Redis error it degrades to the per-process fallback (cap multiplies per instance, alerts never go fully silent). Regression tests in `worker-index.test.ts`: 3 terminal failures across websites/queues in one org → 1 email (3 fail without the fix); another org still alerts; health errors share the budget while recoveries send; the next window alerts again.

### A-WRK-17 — P3 — CONFIRMED — Scheduler silently drops enqueues when Redis is unavailable · FIXED 2026-11-25

- **Where:** `packages/jobs/src/queue.ts:150-162` (`enqueueBulk`),
  `apps/worker/src/scheduler.ts:176-183`.
- **Evidence:** `enqueueBulk` does `if (!q) continue;` when
  `getQueue` returns null (no `REDIS_URL` / `bullConnectionOptions()`
  null) — no log, no counter, no error. The scheduler then logs "tick
  enqueued jobs" only `if (submitted)`, so a Redis outage produces
  **silent ticks that enqueue nothing**. (The manual-sync path does this
  correctly: `api/sync/route.ts` returns 503 `queue_unavailable` and
  marks the row FAILED. The scheduler path has no equivalent signal.)
  The worker process itself exits 1 at boot without Redis
  (`index.ts:128-132`), so this path is reachable mainly when Redis
  _becomes_ unavailable after boot — but `getQueue` re-checks
  `bullConnectionOptions()` per call, so a mid-run Redis loss lands here.
- **Correction:** log an error and `incr("scheduler.enqueue_skipped_no_redis")`
  when a queue is unavailable in `enqueueBulk`, and surface it on
  `/metrics` / the health endpoint.
- **Regression test:** unit test asserting `enqueueBulk` without Redis
  records the skip (requires injecting the connection check).
- **Verification (2026-11-25):** `enqueueBulk` now records a skipped
  queue instead of dropping it silently: one error log per skipped
  queue (`enqueueBulk skipped jobs: no Redis connection`, with the
  queue name and skipped count) and
  `incr("scheduler.enqueue_skipped_no_redis", list.length)` counting
  the dropped jobs — surfaced on the worker's `/metrics` via
  `counterSnapshot`, like every other in-process counter. The single
  `enqueue` path is unchanged: it returns null and its callers already
  surface it (api/sync 503 `queue_unavailable`). Regression tests in
  `lib-queue.test.ts`: without `REDIS_URL` the counter records 3
  dropped jobs across two queues (fails without the fix); with Redis
  nothing is recorded. No connection-check injection was needed — the
  existing harness already controls `bullConnectionOptions()` via
  `REDIS_URL`.

### A-WRK-18 — P3 — CONFIRMED — DLQ rows are pruned after 30 days with no notice · FIXED 2026-11-25

- **Where:** `apps/worker/src/scheduler.ts:186-189`.
- **Evidence:** the retention prune deletes `AnalyticsSyncJob` rows with
  `status: { in: ["SUCCEEDED", "FAILED"] }` older than 30 days. FAILED
  rows _are_ the dead-letter queue (the Sync page + requeue API read
  them). A failed job that nobody requeues within 30 days disappears
  from the DLQ silently — no "expired from DLQ" record, no audit entry,
  and the Sync page gives no retention hint. (The 30-day retention itself
  is a reasonable policy; the gap is discoverability.)
- **Correction:** exclude FAILED rows from the 30-day prune (or give them
  a longer window, e.g. 90 days), or write an audit entry / surface the
  retention on the Sync page.
- **Regression test:** retention test asserting a 31-day-old FAILED row is
  (or is not, per the chosen policy) still present.
- **Verification (2026-11-25):** FAILED rows now use a 90-day retention window (`FAILED_RETENTION_DAYS` in `apps/worker/src/scheduler.ts`) instead of 30 days — the sync-job prune's where clause is an OR: SUCCEEDED/PENDING/RETRYING older than 30 days, FAILED older than 90 days. The A-DB-10 bounded-batch logic (1,000 ids per DELETE, max 10 batches per table per tick) and the stale-RUNNING marking are unchanged (the prune is still a single `pruneInBatches` call). The Sync page now states the retention ("Failed jobs are kept for 90 days so they can be requeued; older ones are pruned automatically."), and the data-lifecycle retention table matches. Regression test in `worker-scheduler.test.ts`: a 31-day-old FAILED row survives the tick while a 91-day-old FAILED row and 31-day-old SUCCEEDED/PENDING rows are pruned (fails without the fix); the existing cutoff test pins both windows.

### A-WRK-19 — P3 — CONFIRMED — Health endpoint has no listen-error handler and `/metrics` is unauthenticated · FIXED 2026-11-25

- **Where:** `apps/worker/src/index.ts:266-300` (health server),
  `index.ts:296` (`healthServer.listen(healthPort, …)`).
- **Evidence:** `listen` is called with no `error` handler — if the port
  (default 8080, `WORKER_HEALTH_PORT`) is already in use, Node emits an
  `error` event on the server with no listener and the process crashes
  (after all 10 workers have started). `/healthz`, `/readyz` and
  `/metrics` have no authentication; `/metrics` exposes in-process job
  counters. Exposure is low-sensitivity and the Dockerfile's HEALTHCHECK
  needs `/readyz` unauthenticated, but the crash-on-EADDRINUSE is a
  startup robustness gap.
- **Correction:** attach `healthServer.on("error", …)` that logs and exits
  1 with a clear message; document that the health port must not be
  publicly exposed (bind to localhost / private network where the host
  allows).
- **Regression test:** startup test with the port occupied asserting a
  clean exit code and log line (not an unhandled `error` event).
- **Verification (2026-11-25):** the health server now has an `error` handler (`handleHealthServerError` in `apps/worker/src/index.ts`, exported for tests like the crash handlers) that logs "health server failed — exiting" with the port + sanitized error and exits 1 — an occupied port (EADDRINUSE) is a clean, logged exit instead of an unhandled `error` event crashing the process after all workers started. The unauthenticated endpoints are documented in code as private-network-only (the Docker HEALTHCHECK and the host probe need `/readyz` without credentials; `/metrics` is low-sensitivity counters); the server is deliberately NOT bound to 127.0.0.1 — the Docker HEALTHCHECK runs inside the container (loopback would work there), but Railway's healthcheck probes the service port from outside the container and a loopback-only bind would refuse it. Regression tests: new `worker-health-listen-error.test.ts` occupies the health port before importing the entry point and asserts the log line + exit 1 (fails without the fix — pre-fix the unhandled `error` event lands in the generic uncaught-exception handler), plus a direct handler test in `worker-index.test.ts` (fails without the fix — no such export).

### A-WRK-20 — P3 — POTENTIAL — No `stalled` / `lockRenewalFailed` observability; `websiteId!` assertion in the processor

- **Where:** `apps/worker/src/index.ts:175-180` (`syncWebsite(websiteId!,
…)`), `index.ts:255-261` (only `completed`/`failed` listeners).
- **Evidence:** BullMQ auto-renews job locks (`lockRenewTime =
lockDuration / 2`, verified in installed `worker.js:78-79` and
  `lock-manager.js:27-42`), so the default 30 s `lockDuration` is **not**
  a stalled-job risk while the process is alive — this was checked, not
  assumed. The remaining gap is observability: if lock renewal fails
  (Redis blip) the job is re-run after `maxStalledCount: 1` with no
  listener on `stalled` or `lockRenewalFailed`, so a duplicate execution
  leaves no log line. Separately, `runJob` passes `websiteId!` into
  `syncWebsite` for all six sync queues; a job whose payload lacks
  `websiteId` would reach `getPrimaryIntegration(null)` — Prisma treats
  the null as no match and the sync returns `no_mapping`, so this is
  sloppy typing rather than a crash (verified by tracing
  `getPrimaryIntegration`, `packages/google/src/client.ts:98-106`).
- **Correction:** add `worker.on("stalled", …)` and
  `worker.on("lockRenewalFailed", …)` log lines with counters; replace
  `websiteId!` with an explicit guard returning `skipped` for sync queues
  missing `websiteId`.
- **Regression test:** unit test for a sync job with no `websiteId`
  asserting a `skipped` result, not a throw.

## Verified-correct (spot-checks that held up)

These were checked because the brief required them; they are **not**
findings. Listed so a later reader does not re-litigate them.

- **JobId 3-part colon rule:** all scheduler/manual/requeue ids are exactly
  3 colon-separated parts with no colons inside a part
  (`packages/jobs/src/scheduler.ts:138-143`, `queue.ts:99`,
  `api/sync/route.ts:33`, `api/sync/requeue/route.ts:34-38`). The
  `enqueue` default embeds a UUID + timestamp, never JSON. BullMQ's
  "exactly 3 parts" constraint is real but satisfied everywhere.
- **Jittered backoff:** `jitteredBackoffMs` is registered as the workers'
  custom `backoffStrategy` on **all 10 workers**
  (`index.ts:253`, `queue.ts:55-58`); unit-tested bounds hold
  (`job-backoff.test.ts`, 5 tests). The off-by-one is A-WRK-13, not a
  missing-strategy bug.
- **Priorities:** MANUAL (1) < REQUEUE (2) < REALTIME (5) < SCHEDULED (10),
  applied in scheduler (`scheduler.ts:139-143`), manual sync, and requeue
  (`queue.ts:45-51`); unit-tested.
- **Per-website isolation:** the scheduler enqueues one job per website, so
  one website's failure cannot block another's sync (the failure is
  contained in that job's retries). The exception is _within_ one website
  (A-WRK-07/08). `getPrimaryIntegration` is scoped by `websiteId`
  (`client.ts:98-106`); cache keys embed `organizationId` from the DB
  (`sync.ts:203-210`); alert-admin lookups are scoped by the website's
  org (`index.ts:44-50`).
- **Snapshot writes:** `writeSnapshot` upserts by `cacheKey` with
  `expiresAt = now + ttl` (`packages/db/src/snapshots.ts:15-29`); snapshot
  failure is swallowed so it never fails a sync (`sync.ts:220-223`); TTL
  is `max(cache TTL, sync interval)` (`scheduler.ts:60-69`,
  `snapshot-ttl.test.ts`, 3 tests).
- **Mailer fail-safety:** `mailerMode()` returns `unconfigured` without
  `SMTP_HOST`; `sendMail` logs recipient+subject only and returns without
  sending (`mailer.ts:23-46`); the weekly report checks the mode _before_
  sending and does **not** record `lastSentAt` when SMTP is unconfigured
  (`report.ts:96-101`) — the fail-safe is correct; the retry-duplication
  gap is A-WRK-03. Preview mode (`EMAIL_LOG_PREVIEW=true`) prints full
  bodies to logs, but only behind an explicit opt-in flag.
- **Rate limiting:** per-connection limiter in the sync engine
  (`sync.ts:189-191`, 30/min per `google:${connectionId}`, atomic Lua in
  `packages/shared/src/rate-limit.ts:19-33`); per-queue BullMQ limiters
  (`index.ts:196-207`); realtime backpressure at depth 40
  (`scheduler.ts:104-117`); deterministic stagger
  (`scheduler.ts:37-42`); realtime coalescing via stable jobId
  (`scheduler.ts:132-136`).
- **Graceful shutdown shape:** SIGTERM/SIGINT stop the scheduler, close
  workers, disconnect Prisma/Redis (`index.ts:335-351`); health/readiness
  endpoints exist (`/healthz`, `/readyz` with Redis ping + `SELECT 1`,
  `/metrics`); Dockerfile runs node as PID 1 in exec form so SIGTERM is
  delivered (`apps/worker/Dockerfile`). The gaps are A-WRK-11/19.
- **Worker hosting reality:** `docker-compose.yml` defines only Postgres +
  Redis (no worker service); the worker runs via `pnpm worker` (tsx) or
  the provided Dockerfile (`docker build -f apps/worker/Dockerfile`).
  No worker is deployed — all runtime claims in this doc are therefore
  static/NOT RUN by construction.

## Per-category verdicts

| Category                                                         | Verdict              | Basis                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job creation & persistence (bookkeeping rows, payload retention) | **PASS** (with note) | A-WRK-01 REFUTED on dynamic verification 2026-11-23: duplicate manual sync returns 409 via the unique `externalId`, no orphan PENDING rows; the no-Redis path marks the single row FAILED. Residual: the 409 should be a typed `already_queued` (A-API-06). |
| Retries & backoff                                                | **PASS** (with note) | Custom jittered strategy on all workers, 5 attempts, priorities; A-WRK-13 documents the real (1-based) schedule; A-WRK-14 rate-limit accounting gap                                                                                                         |
| Idempotency / dedup (jobIds)                                     | **PASS** (with note) | A-WRK-01 REFUTED 2026-11-23: the hour-bucketed jobId + unique `externalId` dedupes duplicates at the DB layer (409); manual re-sync within the hour is impossible by design — see A-API-06 for the UX gap.                                                  |
| Concurrency & locking (BullMQ locks, scheduler lock)             | **FAIL**             | A-WRK-04 (55 s lock vs unbounded tick); lock renewal verified present in BullMQ defaults                                                                                                                                                                    |
| Crash recovery & shutdown                                        | **FAIL**             | A-WRK-11 (no crash handlers, no shutdown timeout, tick not awaited)                                                                                                                                                                                         |
| Queue cleanup & expiration                                       | **PASS** (with note) | `removeOnComplete`/`removeOnFail` bounded; A-WRK-18 DLQ prune after 30 days                                                                                                                                                                                 |
| Tenant isolation of job data                                     | **FAIL**             | A-WRK-02 (DLQ page + APIs unscoped); job payloads / cache keys / alerts otherwise scoped                                                                                                                                                                    |
| Health-transition alerting                                       | **PASS** (with note) | Transition-only emails, best-effort send, tested `healthTransition`; A-WRK-16 alert storm at scale                                                                                                                                                          |
| Scheduled reports (`ReportSchedule`, `isReportDue`)              | **FAIL**             | A-WRK-03 (duplicate mail on retry), A-WRK-06 (no catch-up), A-WRK-10 (200-site silent truncation)                                                                                                                                                           |
| Mailer fail-safety (SMTP unconfigured)                           | **PASS**             | `mailerMode` gate before send; `lastSentAt` not recorded; no body in logs                                                                                                                                                                                   |
| Sync engine & per-website isolation                              | **FAIL**             | A-WRK-07/08 (no per-provider isolation within a website); cross-website isolation holds                                                                                                                                                                     |
| Scale methodology (100/1k/10k)                                   | **NOT RUN**          | A-WRK-12: DB timings never run; in-memory JS numbers are not scale evidence; benchmark script diverges from production queries                                                                                                                              |
| Worker runtime / load behaviour                                  | **NOT RUN**          | No Redis/Postgres in sandbox; worker not deployed — no live tick, retry, crash or throughput observation was possible                                                                                                                                       |

## NOT RUN (with reason)

- Worker boot, scheduler ticks, enqueue/dequeue, retries, backoff timing,
  crash recovery, shutdown timing, Redis outage behaviour — **no Redis**.
- Any Prisma query timing (benchmark script, scheduler groupBy, prune
  deletes) — **no Postgres**.
- SMTP delivery, report-send duplication, alert-email volume — **no SMTP,
  no worker**.
- Throughput at 100/1k/10k websites — **no database, no worker, no Google
  credentials**; the benchmark script exists but was not executed.
- Production health/readiness endpoints — **worker not deployed**.

## Counts

- P0: **0** · P1: **2** (A-WRK-02, -03) · P2: **9** (A-WRK-04…-12) ·
  P3: **9** (A-WRK-01 downgraded from P1 on dynamic verification 2026-11-23, A-WRK-13…-20) · **Total: 20**
