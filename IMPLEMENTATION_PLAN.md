# Implementation Plan

> **Historical document (2026-11-18).** This plan describes the original
> greenfield build before the monorepo migration. Current layout:
> `apps/web`, `apps/worker`, `packages/{db,auth,google,jobs,shared}`
> (see README "Repo layout"). Kept for provenance; do not follow its
> file paths.

## Audit finding

There is **no existing Next.js CMS** in this workspace — only the Astro cottage-food starter
(`~/workspace/cottage-food-blog-starter/`, astro ^7, no Prisma/auth). This app was therefore
created from scratch at `~/workspace/metricflock/`, reusing nothing except the cottage-food
site domains as seed example data. The Astro blog was left untouched.

## Existing architecture reused

- None (greenfield). Conventions follow the spec's target stack.

## Files created

- Scaffold: package.json, tsconfig, next.config.ts, Tailwind 4 + PostCSS, docker-compose.yml, .env.example, README.md
- Prisma: schema.prisma (18 models — the original 16 plus better-auth `Account`
  and `Verification`), seed.ts (demo admin via better-auth scrypt hash),
  migrations: `20261118000000_init` + `20261119000000_better_auth` (Prisma-generated
  diff, see below), `prisma.config.ts` (Prisma 7 datasource config)
- Lib: prisma, env, crypto (AES-256-GCM), auth (better-auth + Prisma adapter;
  `src/lib/auth-server.ts` owns the `auth` object, `getSessionUser()` and
  `requireAuth()`; `src/lib/auth.ts` re-exports them; `src/lib/auth-client.ts`
  is the React client), permissions (17), audit, tenant (server-side isolation),
  rate-limit, cache (Redis, tenant-scoped keys), validation (zod),
  analytics-handler, analytics-response, queue, scheduler, health
- Google: oauth (HMAC state, offline, incremental), tokens (refresh/rotation/revoke), client (website→team resolution), discovery, ga4, search-console, adsense, ad-manager (optional flag)
- API: google oauth connect/callback, connections list/disconnect, properties discover/map; analytics overview/realtime/traffic/audience/pages/events/search-console/adsense/ad-manager; websites CRUD/assign/transfer; teams CRUD/members; auth login/logout; sync trigger
- UI: layout + sidebar, dashboard, websites (+detail with Recharts + TanStack Query), teams, my team, integrations, transfers, audit, login; ui components, MetricCard, DateRangePicker, ConnectionStatus, WebsiteAnalytics
- Workers: BullMQ workers for all 9 queues + scheduler intervals
- Tests: 9 unit test files (mocked Google clients, labelled), integration README for real-account mode
- Docs: 11 guides in docs/

## Database changes

New Postgres schema (see prisma/schema.prisma). No existing DB was modified.

## Dependencies (stable only)

next 16.4.6, react 19.3.1, typescript 7.0.2, prisma 7.10.1, @prisma/client 7.10.1,
tailwindcss 4.3.5, lucide-react 1.75.0, zod 4.6.7, @tanstack/react-query,
recharts 3.11.0, googleapis 190, @google-analytics/data 7.3.0, google-gax 6.17.0
(direct dep: `src/lib/google/auth-types.ts` imports it; pnpm does not hoist
transitive deps), bullmq 6.7.7, ioredis 6, better-auth 1.7.26, dotenv 18,
marked 18.2.1, vitest 5.1.1, tsx, eslint 10.15.0, prettier 3.10.1, husky 9.1.7,
@opennextjs/cloudflare 1.20.17, wrangler 4.165.0. Package manager: pnpm 12.21.0,
Node >= 26.

- Prisma 8 was NOT used: npm `latest` for prisma is 8.0.0-rc.34 (an RC, not
  stable). 7.10.1 is the last stable (`prev` tag) and is what is pinned.
- Prisma 7 needs a driver adapter on the client: `@prisma/adapter-pg@7.10.1`
  - `pg@8.23.1` (+ `@types/pg` dev) were added; `src/lib/prisma.ts` passes a
    `PrismaPg` adapter to `PrismaClient`. The URL in `prisma.config.ts` only
    serves migrate/generate — without the adapter the build fails with
    `PrismaClientConstructorValidationError` during page-data collection.
- `tailwindcss` in the user's package.json was `^4.3.15`, which does not exist
  (latest is 4.3.5); corrected to `^4.3.5`.

## Security considerations

- Tokens AES-256-GCM encrypted at rest; key from env; never logged.
- HMAC-signed OAuth state, CSRF via sameSite cookies, httpOnly session cookies.
- Server-side tenant isolation on every route (assertWebsiteAccess/assertTeamAccess); frontend visibility is not security.
- Zod validation on all inputs; rate limiting on login; audit logging for important actions.
- Ad Manager disabled by default; no mock data presented as real.

## Phases

1 Foundation ✓ (reworked 2026-11-19: better-auth replaces custom sessions +
bcryptjs — see "Phase 1 rework" below) · 2 OAuth ✓ · 3-5 Google APIs ✓ ·
6 Dashboards ✓ · 7 Background ✓ · 8 Flipping ✓ · 9 QA (unit tests + build;
real-Google verification still pending — needs a real account).

## Phase 1 rework (2026-11-19, after the user's package upgrades)

- Auth migrated to better-auth 1.7.26 with the Prisma adapter
  (`emailAndPassword`, scrypt hashes in `Account`). `User` now carries the
  better-auth fields (`name` non-null, `email @unique`, `emailVerified`,
  `image`); `passwordHash` is gone; `Session` is the better-auth shape
  (`token`, `ipAddress`, `userAgent`); new `Account` + `Verification` models.
  The 17-permission system and server-side tenant isolation are unchanged in
  behaviour. `src/lib/auth.ts` still exports `getSessionUser()` /
  `requireAuth()` so all routes and pages work unmodified.
- Prisma 7: datasource URL moved from the schema to `prisma.config.ts`
  (required — `url` in the schema is a P1012 error in Prisma 7).
  New migration `prisma/migrations/20261119000000_better_auth/migration.sql`
  (80 lines, Prisma-generated diff from the old schema; old sessions deleted
  and NULL names backfilled before `name` becomes NOT NULL).
- Missing files added: `scripts/db-manager.ts` (`db:status` / dev-only
  `db:reset`), `.husky/pre-commit` (runs `pnpm typecheck`), `eslint.config.mjs`
  (ESLint 10 flat config via FlatCompat + `next/core-web-vitals`),
  `.prettierrc` (prettier-plugin-tailwindcss), `wrangler.jsonc` (minimal
  Cloudflare scaffolding), `cloudflare-env.d.ts` (placeholder until
  `cf-typegen` generates it). Stale empty `src/components/ui/` directory
  removed (`ui.tsx` is the real file).
- Version corrections: typescript `^6.0.3` → `^7.0.2`, packageManager
  `pnpm@12.19.0` → `pnpm@12.21.0`, `tailwindcss` `^4.3.15` → `^4.3.5`
  (4.3.15 does not exist). Prisma kept at 7.10.1 (8.0.0-rc.34 is an RC).
  `google-gax@6.17.0` added as a direct dependency (see Dependencies).
  Stale npm `package-lock.json` deleted after `pnpm install` produced
  `pnpm-lock.yaml`.
- pnpm 12 notes: `pnpm approve-builds --all` (allowlist now in
  `pnpm-workspace.yaml` as `allowBuilds`), `minimumReleaseAge: 0` (pnpm 12
  defaults to 1440 min and rejects wrangler/miniflare published <24h ago).
  Corepack is absent in this sandbox, so pnpm was installed via
  `npm i -g pnpm@12.21.0` + `pnpm self-update`; the declared manager is
  still pnpm@12.21.0.

## Verification (2026-11-19, this environment — Phase 1 rework)

- `pnpm install` (pnpm 12.21.0, Node 24.22.1 in this sandbox — engines want
  > =26, so it prints an "Unsupported engine" warning, not a failure):
  > SUCCEEDS after `pnpm approve-builds --all` and `minimumReleaseAge: 0`
  > (see pnpm 12 notes above). Produces `pnpm-lock.yaml`; stale npm
  > `package-lock.json` deleted.
- `prisma validate`: valid. `prisma generate`: client (v7.10.1) generated.
  New migration `prisma/migrations/20261119000000_better_auth/migration.sql`
  (80 lines, Prisma-generated diff + safety preamble).
- `pnpm typecheck` (TypeScript 7.0.2): PASSES, zero errors.
- `pnpm test` (vitest 5.1.1): 9 files, 30 tests, all pass. No test needed
  changes for the better-auth migration (none imported the old auth helpers).
- `pnpm build` (Next 16.4.6): PASSES, 35 routes (was 25 — the user's
  updates added routes, plus the new `/api/auth/[...all]` mount).
  First build failed with `PrismaClientConstructorValidationError` (Prisma 7
  needs a driver adapter); fixed with `@prisma/adapter-pg` + `pg`.
- `pnpm lint` (ESLint 10.15.0): PASSES with the reduced config
  (@eslint/js + react-hooks). `next/core-web-vitals` cannot run on TS 7.0
  yet — typescript-eslint 8.73.0 (latest stable) refuses to load
  ("typescript-eslint does not support TS 7.0", issue #10940); re-add it
  once a stable typescript-eslint supports TS 7.
- NOT run here (no Postgres/Redis/Docker in this sandbox): `pnpm db:migrate`,
  `pnpm db:seed`, `pnpm db:status`, worker, runtime smoke test. No real
  Google account connected — no live GA4/Search Console/AdSense verification.
- Sandbox quirk: the egress proxy resets Prisma CLI's Node-fetch downloads
  (ECONNRESET); the schema-engine binary was fetched with curl and verified
  against its `.sha256` (7116e002…). On a normal network this is unnecessary.

## Verification (2026-11-18, this environment — original build)

- `npx prisma validate`: valid. `npx prisma generate`: client generated and loads.
  Migration SQL: `prisma/migrations/20261118000000_init/migration.sql` (470 lines,
  18 CREATE TABLE) generated via `prisma migrate diff --from-empty` (no live DB).
- `npm run build` (`next build`, Next 16.4.6 / Turbopack): PASSES, all 25 routes.
- `npm test` (vitest 4.1.12): 9 files, 30 tests, all pass.
- Runtime smoke test (`next start`): /login 200, /dashboard without session 307
  to /login, /api/analytics/realtime without session returns 401 unauthenticated.
- NOT verified: no Postgres/Redis in this environment (no Docker either), so
  `prisma migrate deploy`, seed, and worker runs were not executed here; no real
  Google account is connected, so no live GA4/Search Console/AdSense data was
  verified (see tests/integration/README.md for the manual procedure).
- Sandbox quirk: the egress proxy resets Prisma CLI's internal engine downloads;
  engines were pre-seeded via curl + sha256 files (see docs/troubleshooting.md).
  On a normal network this is unnecessary.
