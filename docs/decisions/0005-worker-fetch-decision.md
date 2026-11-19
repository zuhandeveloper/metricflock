# ADR-0005: The Worker — Move First, Decide the Real Fetch Before Step 3.6

Date: 2026-11-18
Status: Proposed (Phase 2) — **decision required before migration step 3.6**

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
