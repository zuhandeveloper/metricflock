# ADR-0006: Deployment Topology — Web on Vercel or Cloudflare OpenNext, Worker on a Long-Running Node Host

Date: 2026-11-18
Status: Proposed (Phase 2) — shapes deploy wiring in migration step 3.8;
**the production cutover is a separate decision and is not part of Phase 3.**

## Context

Today there is no deployment config that works: no `vercel.json`, no CI, and
`wrangler.jsonc` is OpenNext scaffolding that says "do not deploy from this
file alone." The monorepo will have two deployables (`apps/web`, `apps/worker`)
with different runtime needs: the web app is a Next.js server; the worker is
a long-running BullMQ process holding persistent Redis connections.

## Decision

- **`apps/web`:** Vercel **or** Cloudflare OpenNext. Both are valid Next.js
  hosts; the choice is made during step 3.8 based on cost and on how much of
  the existing OpenNext scaffolding is salvageable. Vercel is the lower-friction
  default (native Next.js, no adapter work); Cloudflare is the choice if the
  project stays on Workers for the blog and wants one vendor. Either way, the
  web deploy is `turbo run build --filter=@metricflock/web` (or the
  per-app equivalent) from the workspace root.
- **`apps/worker`:** a long-running Node 26 host — Render, Fly.io, or a VPS
  running the `Dockerfile` added in step 3.6. **Not Cloudflare Workers:**
  Workers cannot hold the persistent Redis connections BullMQ needs, and the
  worker is not request-scoped.
- **Data plane unchanged:** Prisma Postgres (current `db.prisma.io` instance)
  and Redis stay as they are; the worker and web share them. No D1, no Queues,
  no new data stores in Phase 3.
- **Per-process env** follows target architecture §6: the worker gets
  `DATABASE_URL`, `REDIS_URL`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, and the
  `GOOGLE_*_ENABLED` flags — no session secret, no OAuth client secret.

## Alternatives considered

- **Everything on Cloudflare (Workers + Queues + D1):** would require
  replacing BullMQ with Cloudflare Queues and Postgres with D1 — a platform
  migration disguised as a deploy choice. Out of scope; the data plane is
  explicitly unchanged.
- **Worker as a Vercel Cron / serverless function:** BullMQ workers are
  long-lived consumers, not cron invocations. Cron could enqueue, but cannot
  replace the consumer. (A Vercel Cron that hits `/api/sync` is a valid
  _trigger_ for the manual endpoint, and is worth considering separately —
  it does not change the worker's host.)
- **Single host running web + worker together:** works for now, but couples
  their scaling and deploys — the exact coupling the monorepo is meant to
  remove. Keep them separately deployable even if they initially share a host.

## Consequences

- Two deploy targets, two sets of env vars, one repo. CI builds both;
  deploys are independent (a web deploy never restarts the worker).
- The cutover is deliberately **not** in Phase 3: after the migration branch
  merges, production keeps running the old layout until the new deployables
  are verified on staging. That verification is its own task with its own
  approval.
