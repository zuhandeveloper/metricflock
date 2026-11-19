# Monorepo Migration Plan — MetricFlock (Phase 2)

Status (2026-11-19): Phase 3 EXECUTION IS DONE LOCALLY — steps 3.1–3.8 are
finished and green (typecheck, lint, 30/30 tests, build, clean-checkout
build). The pushes are queued in order (3.4 → 3.5 → 3.6 → 3.7 → 3.8) behind
a push approval that timed out; the branch head is still the 3.3 commit.
Production stays on the current single-package layout until the migration
branch is merged and verified — merging needs a separate approval.
Basis: `current-state-audit.md` (Phase 1, baseline commit `417cafe2`).
Target: `target-architecture.md`. Decisions: `docs/decisions/0001–0006`.

## 1. Goal and non-goals

**Goal:** turn the single-package Next.js app into a pnpm + Turborepo monorepo —
`apps/web`, `apps/worker`, and five library packages (`db`, `auth`, `google`,
`jobs`, `shared`) — so the web app and the background worker can evolve, build,
test, and deploy independently, without duplicating the Prisma client, auth,
or Google clients.

**Non-goals (Phase 3 does not do these):**

- No new features, no UI changes, no API changes. A user cannot tell the migration
  happened, except that the worker either still defers the live fetch or gains it
  (ADR-0005 — the one allowed behaviour decision).
- No production deploy cutover. Deploy wiring is prepared; the cutover is a
  separate decision after the branch merges.
- No second frontend, no `packages/ui` (deferred — see target architecture §5).
- No Turborepo remote cache, no Nx, no microservices.

## 2. Preconditions (must be true before step 3.1)

1. `main` is green: typecheck, lint, 30/30 tests, build — verified in the audit.
2. The migration branch `architecture/monorepo-migration` exists, branched from
   `main` at `417cafe2` (or newer `main`, if it has moved — rebase the branch first).
3. Node 26 is available in CI and on the machine doing the migration (the repo's
   `engines` floor is `>=26`; the sandbox's Node 24 is not the migration runtime).
4. A staging Postgres + Redis exist for the smoke test (the existing `docker-compose`
   pair is enough). No production credentials are used during the migration.

## 3. Sequencing — one commit per step, green at every step

Each step ends with: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`
(30/30), `pnpm build`, and the smoke test (§4) where it applies. If a step is
not green, stop — do not start the next step. Rollback for any step is
`git revert` of that step's commit (§7).

### 3.1 Scaffold the monorepo (no code moves)

- Extend `pnpm-workspace.yaml` with `packages: ["apps/*", "packages/*"]`.
- Add root `package.json` scripts delegating to Turborepo; add `turbo.json`
  (pipeline: `build` depends on `^build`; `typecheck`/`lint`/`test` per package).
- Add Turborepo (latest stable) as a root devDependency.
- Create empty `apps/web`, `apps/worker`, `packages/{db,auth,google,jobs,shared}`
  with minimal `package.json` files (name, version `0.1.0`, `private: true`).
- **Green check:** `pnpm install` succeeds, `turbo run build` runs (no-op).
- Risk: low. Nothing moves.

### 3.2 Extract `packages/db` (the foundation — everything else depends on it)

- Move `prisma/schema.prisma`, `prisma/migrations/*`, `prisma.config.ts` into
  `packages/db/prisma/` (content unchanged).
- Move `src/lib/prisma.ts` → `packages/db/src/client.ts` (the `PrismaPg` adapter
  + singleton, unchanged). Export the client and generated types from the package.
- Move `prisma/seed.ts` → `packages/db/src/seed.ts`, `scripts/db-manager.ts` →
  `packages/db/scripts/` (behaviour unchanged).
- `packages/db/package.json` owns `prisma`, `@prisma/client`,
  `@prisma/adapter-pg`, `pg`, `dotenv`; its `build` runs `prisma generate`.
- Re-point `apps/web` (still at the old location in this step — the web move
  happens in 3.7) to import the client from `@metricflock/db`. Delete the old
  `src/lib/prisma.ts` and `prisma/` only after the new import compiles.
- **Green check:** typecheck, tests, build, `prisma validate` in `packages/db`,
  seed against staging DB (idempotent upserts — safe to re-run).
- Risk: medium. The adapter pattern is the single most load-bearing detail;
  a bare `new PrismaClient()` anywhere fails at runtime, not compile time.
  Mitigation: grep for `new PrismaClient` after the move — exactly one hit,
  in `packages/db/src/client.ts`.

### 3.3 Extract `packages/shared`

- Move `src/lib/env.ts`, `cache.ts`, `crypto.ts`, `validation.ts`,
  `rate-limit.ts`, `api-helpers.ts`, `analytics-handler.ts`,
  `analytics-response.ts`, `audit.ts`, `health.ts` into `packages/shared/src/`.
- No internal dependencies. Split `env.ts` into per-process schemas (web needs
  all vars; worker needs the subset in target architecture §6) — validation
  behaviour unchanged, scope narrowed per process.
- Re-point imports in web/worker to `@metricflock/shared`.
- **Green check:** typecheck, tests (cache-keys, crypto, tenant tests still pass),
  build.
- Risk: low. These files are already dependency-free.

### 3.4 Extract `packages/auth`

- Move `src/lib/auth-server.ts`, `auth-client.ts`, `tenant.ts`, `permissions.ts`
  into `packages/auth/src/`; the `@/lib/auth` re-export shim is deleted and its
  9 call sites import `@metricflock/auth` instead.
- `packages/auth` owns `better-auth` and the only auth instance; `apps/web`
  mounts `/api/auth/[...all]` from it.
- **Green check:** typecheck, tests (permissions, tenant-isolation), build, and
  the smoke test's login step (§4).
- Risk: medium. better-auth's Prisma adapter must receive the client from
  `@metricflock/db`, not a second client. Mitigation: login smoke test on staging.

### 3.5 Extract `packages/google`

- Move `src/lib/google/*` (9 files) into `packages/google/src/` unchanged;
  `../prisma` imports become `@metricflock/db`, token/crypto imports become
  `@metricflock/shared`.
- `packages/google` owns `googleapis`, `@google-analytics/data`, and
  `GOOGLE_TOKEN_ENCRYPTION_KEY`. No other package imports those libraries.
- **Green check:** typecheck, parser tests (ga4/search-console/adsense), build.
- Risk: low-medium. Pure move; the risk is a missed import, caught by typecheck.

### 3.6 Extract `packages/jobs` + `apps/worker`

- Move `src/lib/queue.ts`, `src/lib/scheduler.ts` → `packages/jobs/src/`.
- Move `src/workers/index.ts` → `apps/worker/src/index.ts`; give the worker its
  own `package.json` (`bullmq`, `tsx`, `@metricflock/db`, `@metricflock/jobs`,
  `@metricflock/google` if it gains the fetch) and a `Dockerfile`.
- **Decision point (ADR-0005):** before this step, decide whether the worker
  gains the real Google fetch (recommended) or keeps deferring to `/api/sync`.
  If it gains the fetch, that is the migration's one behaviour change: implement
  it here, behind the existing queue names and `AnalyticsSyncJob` recording,
  and prove it with the smoke test. Do not also change sync intervals or retry
  policy in this step.
- **Green check:** typecheck, build, worker starts against staging Redis + DB
  and processes one queued job (smoke test §4).
- Risk: medium-high. This is the only step with a behaviour decision and the
  only new runtime (a second deployable). Mitigation: keep the old deferral as
  the default if the fetch work is not ready — the move and the fetch are
  separable, and the plan allows shipping the move first.

### 3.7 Slim `apps/web`

- Move `src/app/**` and `src/components/**` into `apps/web/src/`; move
  `next.config.ts`, `tailwind` setup, `public/`, `wrangler.jsonc` into `apps/web/`.
- `apps/web/src/lib/` should end up holding only route-handler glue. Anything
  still there that belongs in a package is a missed move — grep for it.
- Root `package.json` keeps only workspace scripts; root `tsconfig.json` is
  replaced by per-app/per-package configs; the `@/*` alias lives in
  `apps/web/tsconfig.json` only.
- **Green check:** full suite + build + smoke test end to end.
- Risk: medium. Largest file move, but mechanical. Mitigation: `turbo run build`
  from a clean checkout (`rm -rf node_modules .next` + fresh install) to catch
  stale generated-client issues — the exact failure that hit fresh clones before.

### 3.8 CI, deploy wiring, docs

- Add `.github/workflows/ci.yml`: Node 26, `pnpm install --frozen-lockfile`,
  typecheck, lint, tests, build, smoke test. Runs on PRs to `main` and on the
  migration branch.
- Add ESLint `no-restricted-imports` rules enforcing §4 of the target architecture
  (no cross-boundary relative imports, no direct `@prisma/client` outside `db`).
- Wire deploy configs (not cut over): `apps/web` Vercel or Cloudflare OpenNext
  per ADR-0006; `apps/worker` Dockerfile + host notes. Update `docs/deployment.md`
  and the README's repo layout section.
- **Green check:** CI passes on the branch; docs list the new layout.
- Risk: low. No code moves.

## 4. Smoke test (added before 3.1, run at every step)

Automate the existing manual checklist (`tests/integration/README.md`) into a
script that runs against staging Postgres + Redis (`docker compose up -d`):

1. `prisma migrate deploy` + seed (idempotent) — seed admin can log in.
2. Start `apps/web`, sign in as the seed admin (proves `packages/auth` +
   `packages/db` wiring).
3. `GET /api/analytics/overview?websiteId=<seed site>` returns `not_connected`
   (not a 500) — proves routes + Google client wiring without real credentials.
4. Enqueue one sync job via `POST /api/sync`; worker (from 3.6 on) records it
   in `AnalyticsSyncJob`.
5. Transfer the seed website between the two seed teams; old team access 403s,
   history rows remain.

This test exists because the unit suite cannot see cross-package regressions.
It is the migration's safety net, and it stays as a permanent CI job afterwards.

## 5. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Second Prisma client created during the move (bare `new PrismaClient()`) | Medium / high — runtime failure, seed/sync break | One owner (`packages/db`); grep after 3.2; smoke test login + seed |
| Generated client missing at `next build` (fresh-checkout failure seen before) | Medium / medium — build fails | `db#build` (`prisma generate`) is a declared Turbo dependency of `web#build`; clean-checkout build in 3.7 |
| better-auth adapter wired to the wrong client | Low / high — logins break | Smoke test login in 3.4; adapter takes the `db` client as a parameter, never constructs one |
| Worker fetch decision made late, delaying 3.6 | Medium / low | Move first, fetch second — explicitly allowed; deferral is the default |
| TS 7 + typescript-eslint gap (reduced lint config) | Certain / low | Carried over, not fixed by the migration; re-add `next/core-web-vitals` when a stable typescript-eslint supports TS 7 |
| Secret sprawl across two deployables | Medium / medium | Per-process env table (target §6); worker gets no session secret |
| `pnpm-workspace.yaml` `minimumReleaseAge: 0` masking a bad release | Low / low | Keep as-is (needed for fresh stable releases); revisit after the migration |
| Scope creep (new features "while we're in there") | Medium / medium | Non-goals in §1; any feature request goes on the backlog, not the branch |

## 6. Effort estimate (rough, not a commitment)

The codebase is small (~1,900 LOC app code) and the dependency graph is a shallow
tree (audit §12), so the work is mechanical moves + verification, not a rewrite.

| Step | Estimate |
|---|---|
| 3.1 Scaffold | 0.5 day |
| 3.2 `db` | 0.5–1 day |
| 3.3 `shared` | 0.5 day |
| 3.4 `auth` | 0.5–1 day |
| 3.5 `google` | 0.5 day |
| 3.6 `jobs` + worker (move only) | 0.5–1 day |
| 3.6 worker real fetch (if approved) | +1–2 days |
| 3.7 Web slimming + clean-checkout build | 0.5–1 day |
| 3.8 CI + deploy wiring + docs | 1 day |
| **Total (move only)** | **~4–6 focused days** |
| **Total (with worker fetch)** | **~5–8 focused days** |

Estimates assume the person doing it can run staging Postgres + Redis and has
Node 26. They exclude the deploy cutover, which is a separate decision.

## 7. Rollback

- **Per step:** `git revert` the step's commit on the migration branch. Each step
  is self-contained, so reverting one step does not require reverting later ones
  (as long as later steps are reverted first, in reverse order).
- **Whole migration:** abandon the branch. `main` is untouched throughout Phase 3 —
  the migration never merges until §8 is satisfied, so "rollback" is simply not
  merging. Production is never at risk from the migration branch.
- **After merge:** revert the merge commit. The old single-package layout is
  recoverable from `main`'s history at `417cafe2` (or the merge base).

## 8. Definition of done (merge criteria)

- [ ] Every step's green checks pass on the branch, including a clean-checkout build.
- [ ] CI (3.8) passes on the branch; smoke test (§4) passes against staging.
- [ ] `grep -r "new PrismaClient" --include="*.ts" apps packages` returns exactly
      one hit (`packages/db/src/client.ts`).
- [ ] No relative imports cross a package boundary; ESLint boundary rules pass.
- [ ] Worker starts against staging Redis + DB and processes one job.
- [ ] Web serves the seeded login and one `not_connected` analytics response.
- [ ] Docs updated (`docs/deployment.md`, README layout, this plan marked done).
- [ ] User approves the merge. **Merging is a separate approval — finishing the
      branch does not merge it.**

## 9. What happens after (not in this plan)

- Deploy cutover decision (Vercel vs Cloudflare for web; worker host) — ADR-0006
  decides the shape, the cutover itself is a separate task.
- Worker real fetch (if deferred in 3.6) becomes its own task with its own review.
- `packages/ui` when a second frontend appears.
- Turborepo remote cache evaluation.
- Live Google verification (real GA4/Search Console/AdSense data) — still
  outstanding independent of the migration; it needs Google Cloud credentials.
