# Phase 0 Baseline — 2026-11-21

Repository: `https://github.com/zuhandeveloper/metricflock`
Branch: `main` · HEAD: `810faea53f6583f773a08a4a6a6d0381412d4c60`
(matches the brief's reference snapshot; verified via GitHub connector,
no unexpected commits).

## Working-tree state

- The local workspace (`~/workspace/metricflock`) is the working copy;
  GitHub operations go through the connector (no local git checkout).
- Per the brief's operating rules: **no commit or push without explicit
  instruction**; no branch creation; no deploys.
- Local tree divergence found and fixed during Phase 0: local
  `.github/workflows/ci.yml` was a stale pre-Stage-9 copy and
  `codeql.yml` was missing locally (both were applied to `main` via the
  GitHub web UI). Both files were re-synced from `main` (byte sizes
  verified: ci.yml 3422 B, codeql.yml 927 B). No other source divergence
  was found — recent `main` commits are all accounted for.

## Stack (verified from lockfile / package.json files)

| Component                        | Version        |
| -------------------------------- | -------------- |
| Node.js                          | ≥ 26 (engines) |
| pnpm                             | 12.21.0        |
| Next.js                          | 16.4.6         |
| React                            | 19             |
| TypeScript                       | 7.0.2          |
| Prisma                           | 7.10.1         |
| better-auth                      | 1.7.26         |
| BullMQ                           | 6.7.7          |
| Tailwind CSS                     | 4.3.5          |
| Turborepo                        | 2.11.13        |
| PostgreSQL / Redis (CI services) | 16 / 7         |

## Baseline checks (run 2026-11-21, before any changes)

| Check                  | Command                                              | Result                                                                                                |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Formatting             | `pnpm format:check`                                  | ✅ All files Prettier-clean                                                                           |
| Lint                   | `pnpm lint` (ESLint + `scripts/check-boundaries.sh`) | ✅ Pass (boundary checks passed)                                                                      |
| Typecheck              | `turbo run typecheck`                                | ✅ Pass                                                                                               |
| Unit tests             | `turbo run test`                                     | ✅ Pass (98 tests, 20 files per CI)                                                                   |
| Build                  | `turbo run build`                                    | ✅ Pass (10/10 tasks)                                                                                 |
| Dependency audit       | `pnpm audit --prod`                                  | ✅ No known vulnerabilities                                                                           |
| Smoke suite            | `pnpm smoke`                                         | ⏭ Not run locally (needs Postgres + Redis); CI run #182 on this HEAD: ✅ SUCCESS, "ALL CHECKS PASSED" |
| E2E (Playwright + axe) | `test:e2e`                                           | ⏭ CI run #182: ✅ 4/4 passed                                                                          |
| Secret scan            | gitleaks (CI)                                        | ✅ Clean (CI #182)                                                                                    |
| SAST                   | CodeQL + Semgrep (CI)                                | ✅ Clean (latest runs on `main`)                                                                      |

No dependencies or lockfiles were modified to make checks pass.

## Inventory (what was inspected)

- Monorepo: `apps/web`, `apps/worker`, `packages/{db,auth,google,jobs,shared}`.
- Prisma schema + all migrations (`20261120*` Stage 2/3/5/7, `20261121*` invites/backfill).
- All API routes under `apps/web/src/app/api/**` (auth, teams, members, websites, transfers, google/oauth, google/properties, google/connections, analytics ×9, sync, health, metrics).
- Google integration: `packages/google/src/{oauth,tokens,client,discovery,ga4,search-console,adsense,ad-manager,sync}.ts`.
- Worker + scheduler: `apps/worker`, `packages/jobs/src/{queue,scheduler}.ts`.
- Cache/rate-limit/metrics: `packages/shared/src/{cache,rate-limit,metrics,logger,crypto,env}.ts`.
- Auth: `packages/auth/src/{server,tenant,permissions,mailer,api-helpers}.ts`.
- CI: `.github/workflows/{ci,codeql,label,lint,release,scheduled-maintenance,security-audit}.yml`, `.github/dependabot.yml`, `.gitleaks.toml`.
- Docs: `docs/**` (16 guides refreshed 2026-11-21), `docs/audits/PRODUCTION_READINESS_AUDIT.md` (previous program, 93 findings — Stages 1–9 complete).

## Prior program status (context for revalidation)

The 2026-11-20 hardening program (Stages 1–9) is complete and merged.
Many findings in the current brief overlap it; each was revalidated
against current code — see `docs/audit/SECURITY-FINDINGS.md` for
CONFIRMED vs ALREADY-RESOLVED verdicts with evidence.

Live-data status: Google sign-in verified in production; **Search
Console live data verified** against a real account (2026-11-21);
GA4 (REST client) and AdSense earnings verification still pending a
user-side refresh; worker not yet hosted in production.
