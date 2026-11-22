# Scale benchmarks (Phase 5, brief 5.3)

Goal: measure the dashboard query set and scheduler inputs at
100 / 1k / 10k websites, and record whether anything fans out
uncontrollably as the portfolio grows.

## What was measured locally (2026-11-22, sandbox Node)

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
the script below against a real database.

## Database benchmark (run on staging/local)

`packages/db/scripts/benchmark-scale.ts` seeds a scratch organization
at each size, times the exact queries the dashboard page and the
scheduler tick run (counts, 50-row page, relation-filter count,
provider groupBy, last-sync groupBy, scheduler last-success groupBy
and website page scan), then deletes the scratch org.

```bash
BENCH_CONFIRM=1 pnpm --filter @metricflock/db exec tsx scripts/benchmark-scale.ts
# subset: BENCH_SIZES=100,1000
```

Safety rails: refuses to run without `BENCH_CONFIRM=1`, and refuses a
`DATABASE_URL` that looks like the production Prisma Postgres host
unless `BENCH_ALLOW_PROD=1` is also set. Record the output here after
each run with the date and database description.

### Results

_Not yet run against a real database — sandbox has no Postgres.
First run pending (staging or local machine)._

## Provider fan-out assessment

- Dashboard views never fan out to Google: metric cards are DB
  aggregates; per-website analytics load only on that website's page,
  behind the Redis cache (live-on-miss, TTL'd) and the per-connection
  rate limiter.
- Scheduler enqueues are one bulk round trip per queue per tick,
  with realtime backpressure (skips realtime enqueues when the queue
  depth exceeds 40) and stable jobIds that coalesce duplicate cycles.
- Job generation per tick is O(due websites) with a 500-row paged
  scan — no per-website queries (last-success is one windowed
  groupBy).
- Retries: 5 attempts, jittered exponential backoff (60s base, 1h
  cap) — a provider outage cannot synchronize a retry stampede.
- Priorities: manual sync (1) > requeue (2) > realtime (5) >
  scheduled (10), so user-triggered work is never queued behind a
  full-portfolio sweep.

Verdict: no uncontrolled provider fan-out at 100–10k websites in the
current architecture. The remaining scale decision is snapshot-first
dashboards (F-5.4), which trades live freshness for DB-served reads
and requires worker hosting.
