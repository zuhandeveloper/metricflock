# ADR-0002: Package Layout — apps/web, apps/worker, five libraries

Date: 2026-11-18
Status: Proposed (Phase 2)

## Context

The audit found a shallow dependency tree: routes/pages → `src/lib/*` →
Prisma/Google/Redis. The split must follow the seams that already exist
instead of inventing new ones, and each package must have exactly one reason
to change.

## Decision

```
apps/web       Next.js app: routes, pages, components, app config
apps/worker    BullMQ worker: job execution only
packages/db      Prisma schema, migrations, client singleton, seed
packages/auth    better-auth instance, sessions, tenancy, permissions
packages/google  Google OAuth, token refresh/encryption, GA4 / Search Console /
                 AdSense / Ad Manager clients, property discovery
packages/jobs    BullMQ queue definitions, enqueue, sync intervals
packages/shared  env validation, Redis cache, crypto, validation, rate-limit,
                 API/HTTP helpers, audit, health
```

Full file map: `docs/architecture/target-architecture.md` §3.

## Alternatives considered

- **Fewer, bigger packages** (e.g. one `packages/core` holding db+auth+google):
  simpler at first, but it recreates the monolith inside the monorepo — the
  worker would depend on web-adjacent code, and the "one owner per singleton"
  rule would be unenforceable.
- **More, smaller packages** (e.g. split `google` per provider, split `shared`
  per helper): premature. GA4/Search Console/AdSense/Ad Manager share one
  OAuth/token layer; splitting them would create four packages importing the
  same token code. Split a package when it gains a second, genuinely different
  consumer — not before.
- **`packages/ui` now:** deferred. One consumer (web) does not justify a UI
  package; see target architecture §5.

## Consequences

- Each package has a clear owner and a small, reviewable surface.
- The worker depends on `db` + `jobs` + `google` + `shared` — never on `auth`
  or on web code. It cannot accidentally acquire a session dependency.
- Moving a file is a mechanical step; the layout is the plan's unit of work
  (one package per migration step).
