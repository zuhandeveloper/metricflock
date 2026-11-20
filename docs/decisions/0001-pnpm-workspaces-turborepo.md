# ADR-0001: pnpm Workspaces + Turborepo for the Monorepo

Date: 2026-11-18
Status: Proposed (Phase 2 — decides tooling for Phase 3, nothing installed yet)

## Context

MetricFlock is one pnpm 12 package today. The migration splits it into
`apps/web`, `apps/worker`, and five library packages. We need a workspace
mechanism (linking local packages, one install, one lockfile) and a task
runner (build/test/lint/typecheck across packages, in dependency order, with
caching).

## Decision

- **pnpm workspaces** for package linking — `pnpm-workspace.yaml` already exists
  and the repo already uses pnpm 12. No new package manager.
- **Turborepo** (latest stable at migration time) for task orchestration:
  `turbo.json` pipeline with `build` depending on `^build` (so `db#build`
  runs `prisma generate` before `web#build`), plus `test`, `lint`, `typecheck`.
  Local caching only to start.

## Alternatives considered

- **Nx:** more powerful (generators, affected-graph, plugins), but heavier and
  more opinionated than this codebase needs. A 6-package repo does not need
  Nx's graph machinery; its config and conventions would dominate the repo.
- **Plain `pnpm -r` scripts:** no task ordering and no caching. The
  `prisma generate`-before-`next build` ordering — the exact failure mode that
  bit fresh clones — would be unenforced and left to shell-script discipline.
- **npm/yarn workspaces:** would mean changing the package manager the user
  already standardized on (pnpm 12, `pnpm-lock.yaml`). No benefit.

## Consequences

- One lockfile, one install at the root. Fresh clones run `pnpm install` once.
- Builds are ordered and cached; CI runs the same `turbo` commands as local dev.
- Turborepo is an added dependency (root devDependency) and a new config file
  to maintain. If it ever becomes a burden, the fallback is plain `pnpm -r`
  scripts — the workspace layout itself does not depend on Turborepo.
- `pnpm-workspace.yaml` keeps `minimumReleaseAge: 0` (needed for fresh stable
  releases); revisit after the migration.
