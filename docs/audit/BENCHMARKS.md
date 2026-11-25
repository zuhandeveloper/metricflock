# Scale benchmarks (Phase 5, brief 5.3)

Goal: measure the dashboard query set and scheduler inputs at
100 / 1k / 10k websites, and record whether anything fans out
uncontrollably as the portfolio grows.

## What was measured locally (2026-11-22, sandbox Node)

> **Correction (A-WRK-12, 2026-11-24): the table below is a JS
> in-memory micro-benchmark of a dashboard shape that no longer
> exists.** It compares the old O(W×I) JS scan against a single-pass
> JS equivalent; the dashboard now issues a `COUNT` with a relation
> filter in Postgres instead, so neither column measures what the
> dashboard actually runs. The numbers are real arithmetic but say
> nothing about production latency. **Do not cite the "345×" speedup
> (or any row here) as scale evidence.** The table is kept as a
> historical record only. The verdict that matters — measured DB
> timings at 100/1k/10k — is still pending the first real-database
> run (see "Results" below).

The dashboard's old "connected websites" computation loaded every
integration row and ran `integrations.some(...)` per website —
O(websites × integrations) in JS, plus transferring all rows. The
Phase 5 replacement is a single `COUNT` with a relation filter in
Postgres; its JS equivalent (one pass + Set lookup) was benchmarked
in-memory against the old shape (4 integrations per website):

| Websites | Integrations | Old O(W×I) scan | New single-pass | Speedup |
| -------- | ------------ | --------------- | --------------- | ------- |
| 100      | 400          | 1.0 ms          | 0.31 ms         | ~3×     |
| 1,000    | 4,000        | 35.7 ms         | 1.05 ms         | ~34×    |
| 10,000   | 40,000       | 3,019.5 ms      | 8.75 ms         | ~345×   |

Counts matched in all runs. The old shape also shipped 10k website
rows + 40k integration rows to the app server per dashboard view;
the new page transfers one 50-row page plus aggregates.

Caveat: this is the JS-side cost only. End-to-end DB timings need
the script below against a real database — and, per the correction
above, this table must not be quoted as a scale result.

## Database benchmark (run on staging/local)

`packages/db/scripts/benchmark-scale.ts` seeds a scratch organization
at each size, times the exact queries the dashboard page and the
scheduler tick run (counts, 50-row page, relation-filter count,
provider groupBy, dashboard FE-4 last-sync groupBy over the first 50
page ids, scheduler last-sync groupBy, scheduler website page scan),
then deletes the scratch org.

The seed also includes the rows the secondary queries read, so those
are measured against real data instead of empty tables: one recent
SUCCEEDED sync job per website, FAILED (10%) / RETRYING (5%) jobs,
old finished jobs past the 30-day retention window (20% SUCCEEDED,
5% FAILED), stale RUNNING jobs older than 6 hours (first 10 sites),
one analytics-cache snapshot per website, and audit-log rows (2 per
website, first 1000 sites). Measured on top of the dashboard set:
the DLQ FAILED count + page, the audit-log count + page, a
200-key cache read (`readSnapshots` shape), the retention prune
(1,000 old finished job ids + delete, A-DB-10 shape) and the stale
RUNNING → FAILED update. Seed and cleanup (cascade delete) are
timed. The scheduler queries match production exactly (A-WRK-05
per-page scoped last-success groupBy, 500 ids; A-WRK-09 page scan
with `status: { in: ["ACTIVE", "PENDING_SETUP"] }` + the
MAPPED-integration filter).

Redis/worker throughput is measured by the companion script
`apps/worker/scripts/bench-throughput.ts`: it seeds a 1k-site
scratch org, plans with the real `planDueSyncs` planner, enqueues
via `addBulk` onto a scratch queue (`bench-throughput` — never a
production queue, so a live worker cannot consume the jobs), and
drains them with a no-op worker at production concurrency (5).
It reports jobs enqueued per second and jobs processed per minute.
Caveats: the processor is a no-op (Google API latency is excluded)
and the bench worker has no per-queue limiter (production realtime
is limited to 20/min), so the drain rate is the BullMQ/Redis
ceiling, not the rate-limited production rate.

```bash
BENCH_CONFIRM=1 pnpm --filter @metricflock/db exec tsx scripts/benchmark-scale.ts
# subset: BENCH_SIZES=100,1000
BENCH_CONFIRM=1 REDIS_URL=<staging redis> DATABASE_URL=<staging db> \
  pnpm --filter @metricflock/worker exec tsx scripts/bench-throughput.ts
```

Safety rails: both scripts refuse to run without
`BENCH_CONFIRM=1`, and refuse a `DATABASE_URL` that looks like the
production Prisma Postgres host unless `BENCH_ALLOW_PROD=1` is also
set. The throughput script additionally requires `REDIS_URL` and
refuses the production Redis host unless `BENCH_ALLOW_PROD=1` is
set. Record the output here after each run with the date and
database description.

### Results

_Not yet run against a real database — sandbox has no Postgres.
First run pending: it needs Gulzaib's explicit approval to run
against a staging database (owner-flagged, A-WRK-12). The scripts
are aligned with the production queries; only the run itself is
outstanding._

**Revalidation (A-PERF-02, 2026-11-24):** the scheduler has not
changed since A-WRK-12, and the script was re-verified aligned on
all four compared shapes (page scan, per-page scoped last-success
groupBy, stale RUNNING → FAILED, retention prune). Two realignments
made: the prune id-select now orders by id ascending like
production's `pruneInBatches`, and the dashboard's FE-4 per-page
last-sync groupBy (`by: ["websiteId"]`, 50 ids) is now measured
alongside the scheduler's variant. Safety rails re-verified live
(5 refusal tests, exit 1, no connection attempted): both scripts
refuse without `BENCH_CONFIRM=1`; the scale script refuses a
`prisma.io` DATABASE_URL; the throughput script refuses a missing
`REDIS_URL` and the production Redis host. **Run procedure (owner
approval required first):** provision a staging Postgres + staging
Redis (never production); run `BENCH_CONFIRM=1 pnpm --filter
@metricflock/db exec tsx scripts/benchmark-scale.ts` (subset with
`BENCH_SIZES=100,1000` if desired) and then `BENCH_CONFIRM=1
REDIS_URL=<staging redis> DATABASE_URL=<staging db> pnpm --filter
@metricflock/worker exec tsx scripts/bench-throughput.ts`; paste
the per-query timings at 100/1k/10k into "Results" here with the
date and database description. Known gaps in the instrument: the
production analytics-cache prune and OAuth-state prune are not
seeded or measured, and the org-level counts (team/user/connection)
are not measured — none of them scales with website count.

## Provider fan-out assessment

- Dashboard views never fan out to Google: metric cards are DB
  aggregates; per-website analytics load only on that website's page,
  behind the Redis cache (live-on-miss, TTL'd) and the per-connection
  rate limiter.
- Scheduler enqueues are one bulk round trip per queue per tick,
  with realtime backpressure (skips realtime enqueues when the queue
  depth exceeds 40) and stable jobIds that coalesce duplicate cycles.
- Job generation per tick is O(due websites) with a 500-row paged
  scan — no per-website queries (last-success is one per-page
  scoped groupBy, A-WRK-05).
- Retries: 5 attempts, jittered exponential backoff (first retry
  30–60s, doubling per retry, 1h ceiling) — a provider outage cannot
  synchronize a retry stampede.
- Priorities: manual sync (1) > requeue (2) > realtime (5) >
  scheduled (10), so user-triggered work is never queued behind a
  full-portfolio sweep.

Verdict: **not measured yet.** The architecture is designed to
avoid uncontrolled fan-out (the points above are design
statements), but the "no uncontrolled provider fan-out at
100–10k websites" claim must not be made until the first
real-database run is recorded in "Results" above. The remaining
scale decision is snapshot-first dashboards (F-5.4), which trades
live freshness for DB-served reads and requires worker hosting.
