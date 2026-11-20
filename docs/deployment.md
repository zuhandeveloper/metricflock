# Deployment Guide

Monorepo layout: `apps/web` (Next.js app) + `apps/worker` (BullMQ worker) +
`packages/*` (db, auth, google, jobs, shared). See
`docs/architecture/target-architecture.md` §7 and ADR-0006.

1. Provision Postgres 16 + Redis 7 (`docker compose up -d` for local).
2. Set env vars from `apps/web/.env.example` in your host (Vercel/host env, or a
   secret manager). The `.env` file lives in `apps/web/` — Next.js loads it
   from the app directory; the db/worker scripts read the same file via
   `DOTENV_CONFIG_PATH`.
3. `pnpm install --frozen-lockfile && pnpm db:migrate` (`prisma migrate deploy`)
   `&& pnpm build && pnpm start` (web). Or run the smoke test first:
   `pnpm smoke` (needs a built app + Postgres + Redis; see
   `scripts/smoke-test.sh`).
4. Run the worker separately for background sync: `pnpm worker` (needs
   `DATABASE_URL` + `REDIS_URL` + `GOOGLE_TOKEN_ENCRYPTION_KEY` +
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for token refresh; no session
   secret). The worker performs the real Google fetch (ADR-0005(a)): it warms
   the Redis cache the dashboards read, records integration health, refreshes
   expiring tokens, discovers properties, and runs the centralized scheduler
   (60s tick, Redis-locked, dedup jobIds). For a container host, build from the repo root:
   `docker build -f apps/worker/Dockerfile -t metricflock-worker .`
   The worker is a long-running Node process — do NOT put it on Cloudflare
   Workers (BullMQ needs a persistent Redis connection).
5. Point `GOOGLE_REDIRECT_URI` at the production callback URL and add it in Google Cloud Console.
6. Change the seed admin password immediately; create real users.
7. Submit the OAuth app for Google verification before inviting non-test users.

Cloudflare (web only, OpenNext): `pnpm --filter @metricflock/web build:cf` /
`preview:cf` / `deploy:cf`. `apps/web/wrangler.jsonc` is minimal Phase 1
scaffolding — do not deploy from it alone.
