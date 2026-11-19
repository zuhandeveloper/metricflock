# MetricFlock — Multi-Website Google Analytics & Publisher Management

Production-ready multi-tenant Next.js app: organizations, teams, websites, team/website-level
Google OAuth (AES-256-GCM encrypted tokens), GA4, Search Console, AdSense and optional Ad Manager
reporting, background sync via BullMQ/Redis, ownership transfers, and full audit logging.

Auth is [better-auth](https://www.better-auth.com/) with the Prisma adapter
(email + password; scrypt hashes in better-auth's `Account` model). Sessions are
better-auth sessions; `src/lib/auth-server.ts` exposes `getSessionUser()` /
`requireAuth()` with the same signatures the API routes used before.

## Requirements
- **Node.js >= 26** (`engines` in package.json; local dev on Node 24 works with an engines warning)
- **pnpm 12.21.0** (declared `packageManager`; `corepack prepare pnpm@12.21.0 --activate`, or `npm i -g pnpm@12.21.0`)
- PostgreSQL 16 + Redis 7 (via `docker compose up -d`)

## Quick start
```bash
cp .env.example .env   # fill in DATABASE_URL, BETTER_AUTH_SECRET (or SESSION_SECRET), GOOGLE_TOKEN_ENCRYPTION_KEY, Google OAuth creds
docker compose up -d
pnpm install
pnpm db:migrate        # `prisma migrate dev` — or `pnpm db:status` to check first
pnpm db:seed           # demo@example.com / ChangeMe123! — CHANGE IT
pnpm dev
pnpm worker            # separate process, needs Redis
```

Useful scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm db:status`, `pnpm db:reset` (dev only), `pnpm format`.
Cloudflare: `pnpm build:cf` / `pnpm preview:cf` / `pnpm deploy:cf` (OpenNext;
`wrangler.jsonc` is minimal Phase 1 scaffolding — see docs/deployment.md).

## What is real vs. not yet verified
- Real Google clients (`googleapis`, `@google-analytics/data`) are used everywhere; endpoints return
  `status: "not_connected"` / `"missing_data"` explicitly when no connection/property exists.
- **No live Google account has been connected in this environment**, so no GA4/Search Console/AdSense
  data has been verified against a real account. See `tests/integration/README.md` for the manual
  real-account test procedure.
- Unit tests use mocked Google clients and are labelled as such.

## Docs
See `docs/` (Google Cloud setup, OAuth, API enablement, redirect URI, property mapping, teams,
websites, transfers, troubleshooting, env config, deployment) and `IMPLEMENTATION_PLAN.md`.

## Build notes (sandbox)
- pnpm 12 blocks postinstall scripts by default: `pnpm approve-builds --all`
  records the allowlist in `pnpm-workspace.yaml` (`allowBuilds`). pnpm 12 also
  defaults `minimumReleaseAge` to 1440 minutes, which rejects deps published
  <24h ago (wrangler/miniflare); it is set to `0` in `pnpm-workspace.yaml`
  with the reason documented there.
- If `prisma generate/validate` fails with `ECONNRESET` from `binaries.prisma.sh`
  behind a proxy, pre-seed the schema-engine via curl (see
  `docs/troubleshooting.md`): the CLI downloads it to
  `node_modules/.pnpm/@prisma+engines@<ver>/node_modules/@prisma/engines/` —
  verify the `.sha256` file before placing the binary.
