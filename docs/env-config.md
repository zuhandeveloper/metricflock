# Environment Configuration

The canonical template is `apps/web/.env.example`. The `.env` file lives in
`apps/web/` (Next.js loads env from the app directory); the db and worker
scripts read the same file via `DOTENV_CONFIG_PATH`. Do not keep a second
`.env` at the repo root. **Never commit `.env` or real credentials.**

Runtime: Node ≥ 26, pnpm 12.21.0.

## Core

| Variable              | Required | Default                | Purpose                                                                                                                          |
| --------------------- | -------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | ✅       | —                      | PostgreSQL connection string                                                                                                     |
| `REDIS_URL`           | —        | unset = Redis disabled | Cache, rate limits, BullMQ queues, refresh locks. Without it, dashboards still work; manual sync returns `503 queue_unavailable` |
| `NEXT_PUBLIC_APP_URL` | ✅       | —                      | Public app URL (used in links/emails)                                                                                            |

## Auth

| Variable                   | Required | Default                        | Purpose                                                                                 |
| -------------------------- | -------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `SESSION_SECRET`           | ✅       | —                              | Signs OAuth state values; ≥ 32 chars. Fail-closed: missing/short is a hard error        |
| `BETTER_AUTH_SECRET`       | —        | falls back to `SESSION_SECRET` | better-auth secret (≥ 32 chars)                                                         |
| `SEED_DEMO_ADMIN_PASSWORD` | —        | dev default                    | Password for the seeded demo admin — **change it; never seed production with defaults** |

## Google OAuth & APIs

| Variable                        | Required | Default | Purpose                                                                       |
| ------------------------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`              | ✅       | —       | OAuth 2.0 client ID                                                           |
| `GOOGLE_CLIENT_SECRET`          | ✅       | —       | OAuth 2.0 client secret                                                       |
| `GOOGLE_REDIRECT_URI`           | ✅       | —       | OAuth callback; must match the Google client exactly (`docs/redirect-uri.md`) |
| `GOOGLE_ANALYTICS_ENABLED`      | —        | `true`  | Feature flag: GA4                                                             |
| `GOOGLE_SEARCH_CONSOLE_ENABLED` | —        | `true`  | Feature flag: Search Console                                                  |
| `GOOGLE_ADSENSE_ENABLED`        | —        | `true`  | Feature flag: AdSense                                                         |
| `GOOGLE_AD_MANAGER_ENABLED`     | —        | `false` | Feature flag: Ad Manager (also enable the Ad Manager API)                     |

Setup: `docs/google-cloud-setup.md`, `docs/api-enablement.md`.

## Token encryption

| Variable                               | Required | Default | Purpose                                                                          |
| -------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `GOOGLE_TOKEN_ENCRYPTION_KEY`          | ✅       | —       | Base64 of exactly 32 bytes; encrypts stored Google tokens (AES-256-GCM)          |
| `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` | —        | —       | Previous key during a rotation window only (`docs/token-encryption-rotation.md`) |

> ⚠️ The encryption key must be **identical** in every environment that
> touches the same database. A different key cannot decrypt existing
> tokens (`TOKEN_KEY_UNKNOWN`).

## Sync intervals (worker)

Targets, not guarantees — the scheduler coalesces and backpressures.

| Variable                      | Default | Purpose                          |
| ----------------------------- | ------- | -------------------------------- |
| `SYNC_GA4_REALTIME_SECONDS`   | `300`   | GA4 realtime sync cadence        |
| `SYNC_GA4_HISTORICAL_MINUTES` | `45`    | GA4 historical sync cadence      |
| `SYNC_SEARCH_CONSOLE_HOURS`   | `8`     | Search Console sync cadence      |
| `SYNC_ADSENSE_HOURS`          | `3`     | AdSense sync cadence             |
| `SYNC_AD_MANAGER_HOURS`       | `3`     | Ad Manager sync cadence          |
| `SYNC_HEALTH_CHECK_HOURS`     | `1`     | Integration health-check cadence |

## Mail (SMTP)

Used for email verification, password resets, and sync-failure alerts.
When SMTP is unset, the mailer logs messages to the console instead of
sending (fine for local dev; **required** in production for verification
and reset emails).

| Variable    | Default | Purpose          |
| ----------- | ------- | ---------------- |
| `SMTP_HOST` | —       | SMTP server host |
| `SMTP_PORT` | —       | SMTP server port |
| `SMTP_USER` | —       | SMTP username    |
| `SMTP_PASS` | —       | SMTP password    |
| `SMTP_FROM` | —       | From address     |

## Operations

| Variable               | Default | Purpose                                                                         |
| ---------------------- | ------- | ------------------------------------------------------------------------------- |
| `LOG_LEVEL`            | `info`  | `debug` \| `info` \| `warn` \| `error`                                          |
| `AUDIT_RETENTION_DAYS` | `365`   | Audit-log retention in days (worker prune; see docs/security/data-lifecycle.md) |
| `WORKER_HEALTH_PORT`   | `8080`  | Worker health/metrics HTTP port                                                 |

## Startup validation

Required variables are validated at boot — the app fails fast with a clear
error instead of misbehaving later. CI uses documented dummy values (see
`.github/workflows/ci.yml`); they are allowlisted in `.gitleaks.toml` and
must never be used in production.
