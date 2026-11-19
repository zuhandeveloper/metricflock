# ADR-0005: The Worker — Move First, Decide the Real Fetch Before Step 3.6

Date: 2026-11-18
Status: **Accepted — option (a) implemented 2026-11-19** (see "Outcome" below)

## Context

Audit §7: the worker (`src/workers/index.ts`, 23 lines) records each BullMQ job
attempt in `AnalyticsSyncJob` and marks it SUCCEEDED, but **fetches no Google
data**. The live fetch happens in the `/api/sync` route. There is no scheduler
process — `scheduler.ts` is interval constants, and the only job producer is
the manual sync endpoint. So "background sync" today is a bookkeeping stub
plus a manual trigger.

## Decision

Two separable steps, in this order:

1. **Move (always):** `src/workers/index.ts` → `apps/worker/src/index.ts`,
   `queue.ts`/`scheduler.ts` → `packages/jobs`. Behaviour unchanged — the
   worker keeps recording attempts and deferring the fetch. This is shippable
   on its own.
2. **Fetch (decide before step 3.6):** either
   - **(a) Recommended — worker gains the real fetch.** The worker imports
     `@metricflock/google`, resolves the website/team connection, calls the
     provider clients, and writes results/cache the way `/api/sync` does today.
     Queue names, `AnalyticsSyncJob` recording, retry policy, and sync
     intervals stay exactly as they are. This is the migration's **one allowed
     behaviour change**, and it is what makes the worker a real sync engine.
   - **(b) Defer the fetch.** Keep today's deferral. The monorepo ships with
     the gap intact, and the fetch becomes a separate follow-up task.

The default if no decision is made is **(b)** — move first, fetch later.
Option (a) needs its own review because it touches quota/rate-limit handling,
which today lives in one place (the sync route).

## Alternatives considered

- **Implement the fetch as part of the move, without a decision:** rejected.
  It would smuggle a behaviour change into a "mechanical move" step and make
  the step unreviewable.
- **Delete the worker and sync from the API route only:** rejected. The queue
  infrastructure (9 queues, dedup jobIds, backoff) exists for background sync;
  deleting it would remove the scaling path the platform was built for.

## Consequences

- Under (a): the worker becomes the component that actually syncs. `/api/sync`
  becomes a thin enqueue endpoint. The smoke test must prove one job end to
  end on staging before merge.
- Under (b): nothing changes for users, and the migration stays purely
  mechanical — but the worker remains a stub, and that must be recorded as
  known tech debt, not discovered later.
- Either way, the worker stays a long-running Node process (see ADR-0006):
  BullMQ needs persistent Redis connections.

## Outcome (2026-11-19)

Option **(a)** was implemented after the migration completed (spec Phase 7):

- `packages/google/src/sync.ts` — the sync engine: resolves the website/team
  connection, calls the provider clients, warms the same Redis cache keys the
  web dashboards read, and records integration health. Expected states (no
  connection / no mapping / Ad Manager disabled / revoked grant) return a
  status instead of throwing, so they never burn BullMQ attempts; real Google
  API errors throw and retry with backoff. Per-connection rate limiting
  throws `SyncRateLimitError`, which the worker converts to BullMQ's
  `RateLimitError` (job delayed, not failed).
- `apps/worker/src/index.ts` — one processor per queue delegating to the
  engine, with `AnalyticsSyncJob` bookkeeping (RUNNING → SUCCEEDED / RETRYING
  / FAILED, attempts, lastError, nextRunAt) and per-queue BullMQ limiters.
- `apps/worker/src/scheduler.ts` — centralized scheduler: a 60s tick guarded
  by a Redis lock enqueues due syncs per `SYNC_INTERVALS` (pure due-check in
  `packages/jobs` `planDueSyncs`, bucketed dedup jobIds), OAuth refresh for
  tokens expiring within 10 minutes, and property discovery for connections
  with no discovered properties.
- `/api/sync` is now purely the manual enqueue endpoint.
- A latent bug was fixed along the way: queue names were converted to
  `SyncJobType` with a naive uppercase transform (`GA4_HISTORICAL_SYNC`,
  `INTEGRATION_HEALTH_CHECK`, …) that produced values outside the Prisma
  enum; an explicit `SYNC_TYPE_BY_QUEUE` map (and `SYNC_TYPE_BY_REPORT` for
  last-sync lookups) replaced it in the worker, the sync route, and the
  analytics handler.
- Tests: 18 new unit tests with mocked Google clients (sync engine +
  scheduler plan) — 48/48 total. Live verification against a real Google
  account is still outstanding (needs Google Cloud credentials).
