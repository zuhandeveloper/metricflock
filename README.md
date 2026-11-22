# MetricFlock — Multi-Website Google Analytics & Publisher Management

Multi-tenant Next.js app for managing Google analytics & publisher data across
100+ websites: organizations, teams, websites, team/website-level
Google OAuth (AES-256-GCM encrypted tokens), GA4, Search Console, AdSense and optional Ad Manager
reporting, background sync via BullMQ/Redis, ownership transfers, and full audit logging.

Status: Google sign-in is verified in production; live GA4/Search Console data
verification against a real connected account is the remaining launch step (see
"What is real vs. not yet verified" below). The production-hardening program
(`docs/audits/PRODUCTION_READINESS_AUDIT.md`, Stages 1–9) is tracked on the
`security-hardening/production-readiness` branch.

Auth is [better-auth](https://www.better-auth.com/) with the Prisma adapter
(email + password; scrypt hashes in better-auth's `Account` model). Sessions are
better-auth sessions; `packages/auth/src/server.ts` exposes `getSessionUser()` /
`requireAuth()` with the same signatures the API routes used before.

## Repo layout (monorepo, Turborepo + pnpm workspaces)

```
apps/web/       Next.js 16 app: routes, pages, components (src/app, src/components)
apps/worker/    BullMQ worker (long-running Node; Dockerfile included)
packages/db/    Prisma schema, migrations, client, seed
packages/auth/  better-auth, sessions, tenancy, permissions
packages/google/ GA4, Search Console, AdSense, Ad Manager, OAuth
packages/jobs/  BullMQ queues + sync intervals
packages/shared/ env, cache, crypto, validation, rate limiting
```

Root scripts delegate: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck`
(via Turborepo), `pnpm db:*` (via `@metricflock/db`), `pnpm worker`,
`pnpm smoke` (end-to-end smoke test against real Postgres + Redis).
The `.env` file lives in `apps/web/` — see `docs/env-config.md`.

## Requirements

- **Node.js >= 26** (`engines` in package.json; local dev on Node 24 works with an engines warning)
- **pnpm 12.21.0** (declared `packageManager`; `corepack prepare pnpm@12.21.0 --activate`, or `npm i -g pnpm@12.21.0`)
- PostgreSQL 16 + Redis 7 (via `docker compose up -d`)

## Quick start

```bash
cp apps/web/.env.example apps/web/.env   # fill in DATABASE_URL, BETTER_AUTH_SECRET (or SESSION_SECRET), GOOGLE_TOKEN_ENCRYPTION_KEY, Google OAuth creds
docker compose up -d
pnpm install
pnpm db:migrate        # `prisma migrate dev` — or `pnpm db:status` to check first
pnpm db:seed           # demo@example.com / ChangeMe123! — CHANGE IT
pnpm dev
pnpm worker            # separate process, needs Redis
```

Useful scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm db:status`, `pnpm db:reset` (dev only), `pnpm format`, `pnpm smoke`
(end-to-end check against real Postgres + Redis; needs a built app),
`pnpm --filter @metricflock/web test:e2e` (Playwright + axe, needs a built app).
Deployment: Vercel for the web app (see `docs/deployment.md`); the worker
runs anywhere Docker runs (`apps/worker/Dockerfile`).

## What is real vs. not yet verified

- Real Google clients (`googleapis`, `@google-analytics/data`) are used everywhere; endpoints return
  `status: "not_connected"` / `"missing_data"` explicitly when no connection/property exists.
- Google **sign-in** is verified working in production (2026-11-21).
- **Live GA4/Search Console/AdSense data has not yet been verified against a real
  connected account.** See `apps/web/tests/integration/README.md` for the manual
  real-account test procedure.
- Unit tests use mocked Google clients and are labelled as such; route-level
  authorization is proven by the CI smoke suite against real Postgres + Redis
  (`docs/testing/README.md`).

## Docs

See `docs/` — start with `docs/product/overview.md`,
`docs/security/overview.md`, `docs/operations/observability.md`,
`docs/operations/backup-restore.md`, `docs/testing/README.md`, plus Google Cloud
setup, OAuth, API enablement, redirect URI, property mapping, teams,
websites, transfers, troubleshooting, env config, deployment.
`IMPLEMENTATION_PLAN.md` is the historical build plan (pre-monorepo).

## Build notes (sandbox)

- pnpm 12 blocks postinstall scripts by default: `pnpm approve-builds --all`
  records the allowlist in `pnpm-workspace.yaml` (`allowBuilds`).
  `minimumReleaseAge: 1440` in `pnpm-workspace.yaml` refuses package versions
  published <24h ago (supply-chain age gate; lockfile installs unaffected).
- If `prisma generate/validate` fails with `ECONNRESET` from `binaries.prisma.sh`
  behind a proxy, pre-seed the schema-engine via curl (see
  `docs/troubleshooting.md`): the CLI downloads it to
  `node_modules/.pnpm/@prisma+engines@<ver>/node_modules/@prisma/engines/` —
  verify the `.sha256` file before placing the binary.
