# ADR-0003: packages/db Owns the Prisma Schema, Client, and Migrations

Date: 2026-11-18
Status: Proposed (Phase 2)

## Context

Prisma 7 requires a driver adapter: the client must be built with a `PrismaPg`
pool adapter, and the datasource URL lives in `prisma.config.ts`, not in the
schema. The seed saga proved the failure modes — a bare `new PrismaClient()`
throws at runtime, and a missing `prisma generate` breaks fresh clones. The
client singleton in `src/lib/prisma.ts` is currently the only correct
construction site.

## Decision

- `packages/db` is the **only** owner of: `schema.prisma`, `migrations/`,
  `prisma.config.ts`, the `PrismaClient` construction (adapter + singleton),
  and the seed.
- It exports the client instance and the generated types. Every other package
  and app imports the client from `@metricflock/db`.
- **No other package may import `@prisma/client` directly** or construct a
  `PrismaClient`. Enforced by package dependencies + the ESLint boundary rule
  added in migration step 3.8.
- `packages/db`'s `build` script runs `prisma generate`. Turborepo declares
  `web#build` and `worker#build` as depending on `db#build`, so a generated
  client always exists before any consumer builds.
- Migrations run from `packages/db` (`prisma migrate deploy` / `migrate dev`);
  there is exactly one migration history, unchanged in content.

## Alternatives considered

- **Each app constructs its own client:** reproduces the seed-saga bug by
  design — two clients, two pools, two chances to forget the adapter.
- **Keep the schema in the web app and let the worker import it:** the worker
  would depend on `apps/web` internals, violating the dependency rules and
  making the worker undeployable on its own.

## Consequences

- One pool per process (web and worker each get their own client instance from
  the same construction code — that is correct; sharing one pool across
  processes is impossible).
- The `prisma generate` step is a declared build dependency, not tribal
  knowledge. Fresh clones cannot hit the missing-client failure again.
- Schema changes touch one package; all consumers pick them up through the
  workspace version.
