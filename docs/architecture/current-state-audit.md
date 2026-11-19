# Current-State Audit — MetricFlock (monorepo migration, Phase 1)

Date: 2026-11-18 (verified in sandbox, 2026-11-19)
Baseline commit (remote `main` HEAD): `417cafe2` — "Update prisma.ts" (user's dotenv fix)
Local workspace: `~/workspace/metricflock/` — matches remote `main` except CRLF/formatting in `src/lib/prisma.ts`
Auditor note: this audit grounds the migration plan. Nothing in it changes code.

## 1. Baseline verification (this environment)

Sandbox: Node v24.22.1 (below the `engines: node >=26` floor — warning only, checks still pass),
pnpm 12.21.0. All checks run with a dummy `DATABASE_URL` where a DB is required;
no live Postgres/Redis is reachable from the sandbox (known egress limit, not a code fault).

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | 30/30 pass, 9 files, ~5.5 s |
| Prisma | `prisma validate` (dummy URL) | schema valid |
| Build | `pnpm build` (dummy URL) | passes — 37 route entries (26 API + 10 pages + `_not-found`) |

## 2. What the repo is

A single-package Next.js 16.4.6 app (App Router), React 19.3.1, TypeScript 7.0.2 (strict),
Tailwind 4.3.5, Prisma 7.10.1 + PostgreSQL, better-auth 1.7.26, BullMQ 6.7.7 + Redis,
googleapis 190, `@google-analytics/data` 7.3.0. ~1,900 LOC in `src/` + `prisma/` + `scripts/`
(excluding tests and docs). 133 files total (excluding `node_modules/`, `.next/`, `.git`).

Purpose: multi-tenant analytics/publisher management for 100+ websites across teams —
GA4, Search Console, AdSense, Ad Manager via team- and website-level Google OAuth,
Super Admin / Team Admin / Team Member roles, ownership transfers that preserve history.

## 3. Structure

```
metricflock/
  src/app/            10 pages, 26 API routes (9 analytics, 3 auth, 6 google, 1 sync, 3 teams, 4 websites)
  src/components/     6 components (Sidebar, ui, DateRangePicker, QueryProvider, ThemeToggle, WebsiteAnalytics)
  src/lib/            18 files — prisma, auth, tenant, permissions, env, cache, queue, scheduler,
                      crypto, rate-limit, validation, api-helpers, analytics-handler/response, audit, health
  src/lib/google/     9 files — oauth, tokens, client, ga4, search-console, adsense, ad-manager,
                      discovery, auth-types
  src/workers/        index.ts (23 lines) — BullMQ worker entry
  prisma/             schema.prisma (20 models, 9 enums), 2 migrations, seed.ts
  scripts/            db-manager.ts
  tests/unit/         9 files, 30 tests (unit only)
  tests/integration/  README.md only — manual real-account steps, not automated, not run in CI
  docs/               11 guides (Google Cloud, OAuth, env, deployment, transfers, troubleshooting…)
  docker-compose.yml  postgres:16-alpine + redis:7-alpine (local dev only)
  pnpm-workspace.yaml exists, but defines ONE package (no apps/, no packages/)
  wrangler.jsonc      OpenNext/Cloudflare scaffolding only — explicitly not deploy-ready
```

No `.github/workflows`, no `vercel.json`, no Dockerfile, no CI of any kind.

## 4. Database (Prisma 7)

20 models: Organization, User, Session, Account, Verification, Team, TeamMember, Website,
WebsiteAssignment, WebsiteTransfer, GoogleConnection, GoogleProperty, SearchConsoleProperty,
AdSenseAccount, AdManagerNetwork, WebsiteIntegration, AnalyticsCache, AnalyticsSyncJob,
IntegrationHealth, AuditLog. 9 enums (Role, WebsiteStatus, ConnectionOwnerType,
ConnectionStatus, Provider, MappingStatus, TransferStatus, SyncJobStatus, SyncJobType).

Key patterns the migration must preserve:

- **Driver adapter (Prisma 7):** `src/lib/prisma.ts` builds `PrismaClient` with a `PrismaPg`
  pool adapter; the datasource URL lives in `prisma.config.ts` (for migrate/generate only)
  and must never return to `schema.prisma`. `seed.ts` imports the shared client — a bare
  `new PrismaClient()` fails. Any split that duplicates the client breaks this.
- **Lazy pool:** constructing the client with a placeholder URL opens no connection, which
  is what lets `next build` succeed without a DB.
- **better-auth models:** `Session` / `Account` / `Verification` are better-auth-owned
  (scrypt password hashes in `Account.password`). Never hand-roll auth against them.
- **Tenant shape:** everything hangs off `Organization`; websites belong to an org and
  optionally a team; `Website.domain` is unique per org. Transfers are `WebsiteTransfer`
  rows with a status machine, not destructive moves.
- **Tokens:** `GoogleConnection` stores encrypted refresh/access tokens; website-level
  connections win over team-level ones, credentials are never merged
  (`src/lib/google/client.ts` resolution order).

## 5. Auth, tenancy, permissions

- better-auth, email+password, 30-day sessions (refresh at most daily), `BETTER_AUTH_SECRET`
  preferred with fallback to `SESSION_SECRET`. `src/lib/auth.ts` is a re-export shim —
  9 pages + `/api/sync` import `@/lib/auth`, so it is the single seam for the auth move.
- `src/lib/tenant.ts`: server-side `assertTeamAccess` / `assertWebsiteAccess` — org scoping
  is enforced in the DB query, never trusted from the browser.
- `src/lib/permissions.ts`: 17 granular permissions (`analytics.view`, `website.transfer`,
  `audit.view`, …) with role defaults. No per-membership overrides yet.
- Seed admin: `demo@example.com` / `ChangeMe123!` — must be changed before any real use.

## 6. Google integrations

- OAuth 2.0 with per-connection scopes; refresh-token rotation in `lib/google/tokens.ts`;
  token encryption key from env (`GOOGLE_TOKEN_ENCRYPTION_KEY`, base64 of 32 bytes).
- GA4 via `@google-analytics/data`; Search Console + AdSense via `googleapis`;
  **Ad Manager via direct REST** (no googleapis client exists for it).
- Missing data returns `not_connected` / `missing_data`, never zero — parsers are covered
  by unit tests (`ga4-parse`, `search-console-parse`, `adsense-parse`).
- Feature flags default ON except Ad Manager (`GOOGLE_AD_MANAGER_ENABLED=false`).
- Live verification against a real Google account has never been done; Google Cloud
  credentials were never provided. The code paths are real, the data is not yet proven.

## 7. Background sync — the thinnest part (important for the plan)

- `src/lib/queue.ts`: 9 BullMQ queues (`google-oauth-refresh`, `google-property-discovery`,
  `ga4-realtime-sync`, `ga4-historical-sync`, `search-console-sync`, `adsense-sync`,
  `ad-manager-sync`, `analytics-cache-refresh`, `integration-health-check`), 5 attempts,
  exponential backoff from 60 s, dedup jobIds.
- `src/lib/scheduler.ts` is **constants only** (`SYNC_INTERVALS`) — there is no cron,
  no polling loop, no scheduler process. The only producer is `POST /api/sync` (manual).
- `src/workers/index.ts` (23 lines) **records each job attempt in `AnalyticsSyncJob`
  and marks it SUCCEEDED — it does not fetch any Google data.** The live fetch is
  deferred to the sync API route. So today "the worker" is a bookkeeping stub, not a
  sync engine. The migration must decide explicitly whether the worker gains the real
  fetch (recommended) or keeps deferring (see ADR-0005 and plan §5).
- Redis is optional everywhere: `getRedis()` returns null without `REDIS_URL` and caching /
  queueing degrade to no-ops. The web app builds and runs without Redis.

## 8. Env and config

- `src/lib/env.ts`: Zod-validated env; `DATABASE_URL` required, `SESSION_SECRET` ≥ 32 chars,
  `BETTER_AUTH_SECRET` optional ≥ 32 chars. `getEnv()` throws on invalid env, except it
  returns placeholder values during `phase-production-build` so builds pass without secrets.
- `.env.example` documents all vars including sync intervals. No `.env` is committed.
- `next.config.ts` is minimal (`reactStrictMode`, `optimizePackageImports` for
  lucide-react/recharts). `tsconfig.json` maps `@/*` → `./src/*` — a single-app alias
  that will not survive the split; workspace packages must be imported by package name.

## 9. Tests

- 9 unit files, 30 tests, all passing: parsers, crypto, cache keys, OAuth state,
  permissions, tenant isolation, transfer. No component tests, no API route tests,
  no E2E. Integration coverage is a manual README checklist only.
- Consequence: the migration has **no automated test that proves the app still works
  end to end after a move.** The plan adds a smoke test before any code moves (plan §4).

## 10. CI / deploy

- None. No GitHub Actions, no Vercel config, no Dockerfile. `wrangler.jsonc` is
  scaffolding: OpenNext assets/bindings are not wired up, and the file itself says
  "Do not deploy from this file alone." Deployment today is manual (`pnpm build`,
  `pnpm start`, `pnpm worker` on a host with Postgres + Redis).

## 11. Findings (ranked)

1. **No CI** — regressions are caught by hand. Any monorepo must add CI first, or the
   split will be verified by hand too.
2. **Worker is a stub** — the highest-risk assumption in the migration. Moving it
   as-is preserves behavior but bakes in the gap; giving it the real fetch is the
   one behavior change the plan allows, and it needs an explicit decision.
3. **Single client singleton, single env validator, single `@/*` alias** — three
   singletons that every package will need. The package boundaries (§12) exist to
   keep exactly one owner for each.
4. **Reduced lint config** — `next/core-web-vitals` is disabled because
   typescript-eslint does not support TypeScript 7.0 yet (upstream #10940). Carries
   over to the monorepo; re-add when a stable typescript-eslint supports TS 7.
5. **Node engine floor `>=26`, sandbox runs 24** — CI must run Node 26; local dev
   on 24 passes checks today but is not the supported runtime.
6. **Plaintext dev password in `docker-compose.yml`** — local-dev only, but it is a
   real credential in the repo. Rotate it if the repo is ever shared, and never
   reuse it for staging/production. (Value intentionally not reproduced here.)
7. **No integration tests** — cross-package regressions after the split would be
   invisible to the suite. Mitigated by the smoke test in plan §4.
8. **`pnpm-workspace.yaml` already exists** with `minimumReleaseAge: 0` and allowBuilds
   for Prisma/esbuild/workerd — the workspace mechanism is already half in place;
   the migration extends it rather than introducing a new package manager.

## 12. Coupling map (what depends on what)

```
pages / API routes
  └─► @/lib/auth (shim → auth-server, better-auth) ─► @/lib/prisma ─► pg / Prisma
  └─► @/lib/tenant, @/lib/permissions ─► @/lib/prisma
  └─► @/lib/google/* ─► @/lib/prisma, @/lib/google/tokens (crypto), env
  └─► @/lib/queue (enqueue) ─► @/lib/cache (Redis)     [only /api/sync]
  └─► @/lib/cache, @/lib/env, @/lib/validation, @/lib/rate-limit, @/lib/api-helpers
src/workers/index.ts
  └─► @/lib/cache, @/lib/prisma, @/lib/queue           [no google/* import today]
```

Nothing imports from `src/workers`. Nothing outside `src/app` imports components.
The dependency graph is a shallow tree, not a tangle — this is why the migration
is mechanical rather than a rewrite. The only shared-state hazards are the Prisma
client singleton, the better-auth instance, and the Redis client (all lazy singletons).
