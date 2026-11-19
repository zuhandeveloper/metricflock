# Target Architecture — MetricFlock Monorepo

Status: proposed (Phase 2). Nothing here is implemented yet.
Companion docs: `current-state-audit.md` (where we are),
`monorepo-migration-plan.md` (how we get here), `docs/decisions/` (why).

## 1. Principles

1. **One owner per singleton.** The Prisma client, the better-auth instance, the Redis
   client, and env validation each live in exactly one package. Apps import them;
   they never construct their own.
2. **Apps are thin.** `apps/web` owns routes, pages, and components. `apps/worker`
   owns job execution. All reusable logic lives in `packages/`.
3. **Packages import by name, never by relative path across a boundary.**
   `@metricflock/db`, `@metricflock/auth`, `@metricflock/google`,
   `@metricflock/jobs`, `@metricflock/shared`. The old `@/*` alias stays inside
   `apps/web` only.
4. **No behaviour change** in the migration, except the single explicit decision in
   ADR-0005 (whether the worker gains the real Google fetch). Everything else is
   a move.
5. **Latest stable only, never beta/RC** — same rule as the rest of the project.
   Turborepo, Prisma, and all other versions are pinned to the latest stable at
   migration time, and re-checked at that time (versions in this doc are targets,
   not pins).

## 2. Target tree

```
metricflock/                          # repo root — pnpm workspace + Turborepo
  package.json                        # root scripts only (no app code): build/test/lint/typecheck
  pnpm-workspace.yaml                 # packages: apps/*, packages/*
  turbo.json                          # task pipeline (build/test/lint/typecheck, dependsOn)
  .github/workflows/ci.yml            # install → typecheck → lint → test → build → smoke test (Node 26)
  docker-compose.yml                  # postgres:16 + redis:7 (unchanged, local dev)
  docs/                               # existing guides + architecture/ + decisions/

  apps/
    web/                              # Next.js 16 app (today's src/app, src/components)
      package.json                    # next, react, @metricflock/* deps, tailwind
      next.config.ts  tsconfig.json   # @/* → ./src/* stays, scoped to this app
      src/app/  src/components/  src/lib/   # route handlers + UI only; lib/ shrinks
      public/                         # brand assets (unchanged)
      wrangler.jsonc                  # OpenNext scaffolding (unchanged in Phase 3)
    worker/                           # BullMQ worker (today's src/workers/index.ts)
      package.json                    # bullmq, tsx, @metricflock/db, @metricflock/jobs, @metricflock/shared
      src/index.ts                    # worker entry (moved, then extended per ADR-0005)
      Dockerfile                      # long-running Node service (added in Phase 3)

  packages/
    db/                               # Prisma schema, migrations, client, seed
      package.json                    # prisma, @prisma/client, @prisma/adapter-pg, pg, dotenv
      prisma/schema.prisma  prisma/migrations/*  prisma.config.ts
      src/client.ts                   # PrismaPg adapter + singleton (today's src/lib/prisma.ts)
      src/seed.ts                     # today's prisma/seed.ts (moved, unchanged behaviour)
      scripts/db-manager.ts           # today's scripts/db-manager.ts
    auth/                             # better-auth + tenancy + permissions
      package.json                    # better-auth, @metricflock/db, @metricflock/shared
      src/server.ts                   # better-auth instance (today's src/lib/auth-server.ts)
      src/client.ts                   # browser helpers (today's src/lib/auth-client.ts)
      src/session.ts                  # getSessionUser / requireAuth / destroySession / SESSION_COOKIE
      src/tenant.ts  src/permissions.ts   # today's src/lib/tenant.ts, src/lib/permissions.ts
    google/                           # all Google API access
      package.json                    # googleapis, @google-analytics/data, @metricflock/db, @metricflock/shared
      src/oauth.ts  src/tokens.ts  src/client.ts   # OAuth flow, refresh, connection resolution
      src/ga4.ts  src/search-console.ts  src/adsense.ts  src/ad-manager.ts
      src/discovery.ts  src/auth-types.ts
    jobs/                             # BullMQ queues + sync scheduling
      package.json                    # bullmq, ioredis, @metricflock/db, @metricflock/shared
      src/queues.ts                   # QUEUE_NAMES, getQueue, enqueue (today's src/lib/queue.ts)
      src/scheduler.ts                # SYNC_INTERVALS (today's src/lib/scheduler.ts)
    shared/                           # env, cache, crypto, validation, HTTP helpers
      package.json                    # zod, ioredis, (no internal deps)
      src/env.ts                      # today's src/lib/env.ts (per-process validation)
      src/cache.ts                    # Redis client + cacheGet/cacheSet + key builder
      src/crypto.ts                   # token encryption helpers (today's src/lib/crypto.ts)
      src/validation.ts  src/rate-limit.ts
      src/api-helpers.ts  src/analytics-handler.ts  src/analytics-response.ts
      src/audit.ts  src/health.ts
    ui/                               # DEFERRED — see §5. Shared React components stay in
                                      # apps/web until a second app needs them.
```

## 3. Package map (what moves where)

| Today | Target | Notes |
|---|---|---|
| `prisma/schema.prisma`, `prisma/migrations/*`, `prisma.config.ts` | `packages/db/prisma/` | Unchanged content; `prisma generate` runs in this package |
| `src/lib/prisma.ts` | `packages/db/src/client.ts` | The adapter + singleton. One owner. |
| `prisma/seed.ts`, `scripts/db-manager.ts` | `packages/db/src/seed.ts`, `packages/db/scripts/` | Same behaviour; `pnpm --filter @metricflock/db db:seed` |
| `src/lib/auth-server.ts`, `src/lib/auth-client.ts`, `src/lib/auth.ts` | `packages/auth/src/` | The `@/lib/auth` shim disappears; callers import `@metricflock/auth`. New `handler.ts` holds the better-auth Next.js handler so no file outside the package imports better-auth |
| `src/lib/tenant.ts`, `src/lib/permissions.ts`, `src/lib/api-helpers.ts` | `packages/auth/src/` | Need `User` type + Prisma — they live with auth, not db |
| `src/lib/google/*` (9 files) | `packages/google/src/` | Unchanged internals; imports of `../prisma` become `@metricflock/db`. New `getGoogleAccountProfile()` helper so the OAuth callback no longer calls `googleapis` directly |
| `src/lib/queue.ts`, `src/lib/scheduler.ts` | `packages/jobs/src/` | Queue names + intervals; worker and web both depend on it |
| `src/lib/env.ts`, `cache.ts`, `crypto.ts`, `validation.ts`, `rate-limit.ts` | `packages/shared/src/` | No internal deps; pure + Redis + Zod |
| `src/lib/audit.ts`, `src/lib/health.ts` | `packages/db/src/` | They import Prisma, so they live with db (subpath exports `./audit`, `./health`), not shared |
| `src/lib/analytics-handler.ts`, `src/lib/analytics-response.ts` | `apps/web/src/lib/` | Route-handler glue; stays with the app, not a package |
| `src/workers/index.ts` | `apps/worker/src/index.ts` | Entry only at migration time; real fetch added per ADR-0005(a) on 2026-11-19 (sync engine in `packages/google/src/sync.ts`, scheduler in `apps/worker/src/scheduler.ts`) |
| `src/app/**`, `src/components/**` | `apps/web/src/**` | Unchanged, except imports become package imports |
| `next.config.ts`, `tailwind`, `public/`, `wrangler.jsonc` | `apps/web/` | App-scoped config moves with the app |
| `docker-compose.yml`, root `package.json` scripts | repo root | Root scripts delegate: `turbo run build` etc. |

## 4. Dependency rules (enforced, not just documented)

```
apps/web    → db, auth, google, jobs, shared
apps/worker → db, jobs, shared, google      (no auth: the worker uses Prisma directly,
                                             never a user session; google since
                                             ADR-0005(a): the worker performs the
                                             real fetch via @metricflock/google/sync)
packages/auth   → db, shared
packages/google → db, shared
packages/jobs   → shared
packages/shared → (nothing internal)
packages/db     → (nothing internal)
```

Rules:

- Packages never import from `apps/*`. Apps never import from each other.
- No relative imports across a package boundary (`../../packages/...` is a violation).
- `packages/db` exports only the client, the generated types, and the seed.
  Nothing else may import `@prisma/client` directly — the client comes from
  `@metricflock/db`.
- `packages/auth` is the only place that imports `better-auth` and constructs
  the auth instance. `apps/web` mounts the `[...all]` route from it.
- `packages/google` is the only place that imports `googleapis` /
  `@google-analytics/data` and touches `GOOGLE_TOKEN_ENCRYPTION_KEY`.
- Enforcement: per-package `package.json` dependencies (a package can only import
  what it declares) + an ESLint `no-restricted-imports` rule in Phase 3.8 +
  Turborepo pipeline ordering (`db` builds before its dependents).

## 5. What is deliberately NOT in the target

- **`packages/ui` is deferred.** There is one web app; extracting shared components
  now would create a package with one consumer. Revisit when a second frontend
  (admin app, marketing site, mobile) appears. Components stay in `apps/web`.
- **No new services.** No separate API server, no gateway, no microservices.
  The split is web app + worker + libraries, because that is what the code already is.
- **No Turborepo remote cache** initially. Local caching only; remote cache is a
  later optimisation, not a migration requirement.
- **No deploy cutover.** Vercel vs Cloudflare OpenNext for `apps/web` and the host
  for `apps/worker` are decided in ADR-0006 but wired up, not cut over, in Phase 3.
  Production stays on the current deployment until the migration branch is merged
  and verified.
- **No Nx.** Evaluated in ADR-0001; Turborepo fits a pnpm repo of this size.

## 6. Env ownership (per process)

| Variable | web | worker | Owner package |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | `db` (validated in `db`, read in `shared/env`) |
| `REDIS_URL` | yes (cache) | yes (queues) | `shared` |
| `SESSION_SECRET` / `BETTER_AUTH_SECRET` | yes | no | `auth` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | yes | yes (token refresh; redirect URI unused) | `google` |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | yes | yes | `google` |
| `GOOGLE_*_ENABLED` flags | yes | yes | `google` |
| `NEXT_PUBLIC_APP_URL` | yes | no | `web` |
| `SYNC_*` intervals | no | yes | `jobs` |

Each process validates only what it needs at startup and fails loudly otherwise
(today's `getEnv()` behaviour, moved into `packages/shared` with per-app schemas).
Secrets are never shared with a process that does not need them — the worker in
particular gets no session secret.

**Where the `.env` file lives:** `apps/web/.env` (copied from
`apps/web/.env.example`). Next.js loads env from the app directory only, so
the file moved there with the app in step 3.7 — `NEXT_PUBLIC_APP_URL` is
inlined at build time from it, so a root `.env` would silently not apply.
The db and worker scripts read the same file via
`DOTENV_CONFIG_PATH=../../apps/web/.env` (db) / `../web/.env` (worker).
There is exactly one `.env`; do not keep a second copy at the repo root.

## 7. Build, test, and deploy topology (target)

- **Root:** `pnpm install` (workspace), `turbo run typecheck lint test build`.
  Pipeline: `db#build` (prisma generate) → dependents' `build`; `test` and
  `lint` run per package; `typecheck` per package/app.
- **apps/web:** `next build` (runs `prisma generate` first via the `db` dependency
  — the build must never assume a pre-generated client; this is the exact failure
  mode that bit fresh clones in the seed saga).
- **apps/worker:** `tsx src/index.ts`, long-running Node 26 process, requires
  `DATABASE_URL` + `REDIS_URL`; exits non-zero if Redis is missing (today's behaviour).
- **CI (new):** GitHub Actions on every PR to `main`: Node 26, `pnpm install
  --frozen-lockfile`, typecheck, lint, tests, build, plus the smoke test (plan §4).
- **Deploy (wired, not cut over):** `apps/web` → Vercel or Cloudflare OpenNext
  (ADR-0006); `apps/worker` → a long-running Node host (Render/Fly.io/VPS) with
  the same Postgres + Redis. Cloudflare Workers cannot host the BullMQ worker.

## 8. Migration notes (as built, Phase 3 steps 3.1–3.8)

- **Staged root:** the plan said the root `package.json` would become the
  workspace root at 3.1, but Turborepo does not run root-package tasks, so
  the root stayed the app (with delegating `db:*` scripts) until 3.7, when
  `apps/web` took the app and the root became workspace-only. The final
  state matches this document; only the sequencing differed.
- **Turborepo env stripping:** Turborepo strips undeclared env vars from
  task environments, so `db#build` (`prisma generate`, which resolves
  `DATABASE_URL`) failed under `turbo run build` while working standalone.
  Fixed with `globalPassThroughEnv: ["DATABASE_URL"]` in `turbo.json`
  (pass-through, not hashed: the generated client is identical for any URL).
- **Lint scope:** ESLint 10 lints only `.js/.mjs/.cjs` by default, and
  typescript-eslint does not support TypeScript 7.0 yet, so the `.ts/.tsx`
  files are not linted and the boundary rules in `eslint.config.mjs` are
  dormant for them until a TS parser lands (see the config's NOTE). The
  ignore patterns use `**/` so they match every package/app's nested
  `node_modules` — a top-level-only pattern let ESLint traverse the
  workspaces' `node_modules` and blow the 2 GB heap in step 3.7.
- **Tests:** the unit suite lives in `apps/web/tests/` (run by the web
  app's `vitest run`) because it exercises code from every package; packages
  may gain their own suites later.
- **Prisma engine download:** a fresh clone's first `pnpm install` /
  `prisma generate` downloads the Prisma engine binaries from
  `binaries.prisma.sh`. If that download is reset by a proxy, retry the
  install, or pre-seed the schema engine as documented in
  `docs/troubleshooting.md`. The generated client itself is never committed.
