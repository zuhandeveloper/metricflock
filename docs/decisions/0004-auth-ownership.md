# ADR-0004: packages/auth Owns better-auth, Tenancy, and Permissions

Date: 2026-11-18
Status: Proposed (Phase 2)

## Context

Auth is better-auth 1.7.26 (scrypt passwords, 30-day sessions) wired to Prisma
via the `Session` / `Account` / `Verification` models. Tenancy
(`assertTeamAccess` / `assertWebsiteAccess`) and the 17-permission system sit
beside it in `src/lib/`. Nine pages plus `/api/sync` import the `@/lib/auth`
re-export shim, which is the natural seam for the move.

## Decision

- `packages/auth` owns: the better-auth instance (`auth`), the `[...all]` route
  handler export, session helpers (`getSessionUser`, `requireAuth`,
  `destroySession`, `SESSION_COOKIE`), `tenant.ts`, and `permissions.ts`.
- It is the **only** package that imports `better-auth`. It receives its Prisma
  adapter from `@metricflock/db` — it never constructs a client.
- The `@/lib/auth` shim is deleted; callers import `@metricflock/auth`.
- Secrets: `BETTER_AUTH_SECRET` (preferred) falling back to `SESSION_SECRET`,
  both ≥ 32 chars, validated by the shared env schema. The worker does **not**
  depend on `packages/auth` and receives no session secret (it uses Prisma
  directly; there is no user session in a job).

## Alternatives considered

- **Keep auth in the web app:** the worker would not need it today, but
  tenancy/permission checks are also needed by any future service that acts on
  a user's behalf. Centralising them now avoids a second auth implementation
  later. The cost is one small package — acceptable.
- **Split tenancy/permissions into their own package:** they depend on the
  `User` type and Prisma, and their only consumers are auth-guarded code. A
  separate package would be `auth`'s shadow. Keep them together until a
  consumer needs them without auth.

## Consequences

- Login/logout/session behaviour is unchanged; the smoke test proves it on
  staging after the move (migration plan §4).
- Any future app that needs user sessions imports one package and gets the
  same tenancy rules — no drift between apps.
- The worker's lack of an `auth` dependency is a deliberate, visible boundary:
  jobs act as the system, not as a user, and that must stay true.
