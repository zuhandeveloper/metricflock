# Release Gates — Production Hardening & Product Implementation

Final verification record for the 2026-11-21 brief (Phases 0–9).
Verified 2026-11-23 against main @ `51d8c3c8`.

## Gate results

| Gate                | Evidence                                                                            | Status |
| ------------------- | ----------------------------------------------------------------------------------- | ------ |
| Format check        | `pnpm format:check` — all files Prettier-clean                                      | ✅     |
| Lint + boundaries   | `pnpm lint` — ESLint + boundary grep passed                                         | ✅     |
| Typecheck           | turbo `typecheck` 10/10 packages                                                    | ✅     |
| Unit tests          | 38 files / 196 tests passed                                                         | ✅     |
| Coverage thresholds | 99.23 / 92.98 / 96.87 / 100 (gate 90/80/90/90)                                      | ✅     |
| Build               | turbo `build` 10/10                                                                 | ✅     |
| Dependency audit    | `pnpm audit --prod` — no known vulnerabilities                                      | ✅     |
| CI (main)           | CI #204 SUCCESS — unit + smoke (real Postgres/Redis, ALL CHECKS PASSED) + e2e 24/24 | ✅     |
| Security workflows  | Security audit (Semgrep pinned 1.185.0), CodeQL, Lint — green on main               | ✅     |
| Production deploy   | Vercel production deployment READY for main @ `51d8c3c8`                            | ✅     |
| Production health   | `GET https://metricflock.bond/api/health` → `{"status":"ok"}`                       | ✅     |
| Production login    | /login renders (email/password + Google), no errors                                 | ✅     |

## Phase status

| Phase | Scope                                                                          | Status          |
| ----- | ------------------------------------------------------------------------------ | --------------- |
| 0     | Audit + baseline (docs/audit/\*)                                               | ✅ Complete     |
| 1     | P0 tenant isolation (F-1.1–1.4)                                                | ✅ CI #183      |
| 2     | Auth/OAuth/secrets (F-2.1–2.5)                                                 | ✅ CI #184      |
| 3     | Rate limiting, refresh lock, pagination, Ad Manager (F-3.1–3.4)                | ✅ CI #186      |
| 4     | DB integrity, transfer race, deletion/retention/export (F-4.1–4.3)             | ✅ CI #187      |
| 5     | Queue reliability, hybrid snapshots, dashboard bounds (F-5.4–5.6)              | ✅ CI #188      |
| 6     | Audit redaction, nonce CSP, supply chain (F-6.7–6.9)                           | ✅ CI #190      |
| 7     | Product intelligence (portfolio, health alerts, reports, insights, public API) | ✅ CI #193–#200 |
| 8     | UX/accessibility (mobile nav, skip link, signed-in axe gate, journeys)         | ✅ CI #204      |
| 9     | Production verification + release gates (this document)                        | ✅ This record  |

## Open items (owner: Gulzaib)

These do not block the code release; they are operational steps only
the account owner can perform:

1. **Database migrations** — confirmed in sync 2026-11-23: Gulzaib ran
   `pnpm db:migrate` and Prisma reported "Already in sync". For future
   releases use `pnpm db:migrate:deploy` against production (the
   `db:migrate` script is the dev variant, `prisma migrate dev`).
   `pnpm db:status` had a Windows/MSYS2 bug (spawned bare `pnpm` →
   ENOENT); fixed in this push via `npm_execpath` resolution.
2. **Worker hosting** — the BullMQ worker (scheduled sync, snapshot
   writes, health alerts, weekly report sends) is not deployed.
   Recommended: Railway Hobby ($5/mo). Dockerfile is ready; needs
   `DATABASE_URL`, `REDIS_URL`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (same
   value as Vercel) and SMTP settings.
3. **Live-data confirmation** — Search Console verified live
   2026-11-21 (5 clicks / 170 impressions matched Google UI). GA4
   (REST rewrite) and AdSense earnings still await a refresh
   confirmation on the live site.
4. **Brand assets** — `/og.png` and `/favicon.ico` return 404
   (binary files cannot be pushed via the GitHub connector; upload
   via the GitHub web UI). `/logo.svg` works.
5. **GitHub housekeeping** — merge PR #5 (pnpm action bump) in the
   UI; resolve PR #4 (CodeQL grouping — do not merge as-is); create
   the 5 labels (frontend, backend, workflows, documentation,
   tests); repo description/topics (text provided 2026-11-21).
6. **Demo account check (DB-5)** — confirm `demo@example.com` does
   not exist in the production database, or disable it.

## Release recommendation

Tag the current main as **v2.0.0** (major: Phases 1–8 include
breaking data-model changes — composite FKs, exactly-one-owner
constraint — and the full product-intelligence surface). v1.0.0 was
tagged at `9452c83e` before this program. Create the tag/release
after the production migrations above have run, so the release
matches what production actually serves.

## Known limitations (documented, accepted)

- DB scale benchmark timings not yet run against a real Postgres
  (script ready: `packages/db/scripts/benchmark-scale.ts`).
- ESLint does not lint .ts/.tsx (typescript-eslint peer range);
  boundary grep + typecheck are the interim gates.
- Ad Manager remains beta-labeled (no live account verified yet).
- Passkeys and breached-password screening deferred by decision.
