# Environment Configuration

See `apps/web/.env.example`. The `.env` file lives in `apps/web/` (Next.js
loads env from the app directory); the db and worker scripts read the same
file via `DOTENV_CONFIG_PATH`. Do not keep a second `.env` at the repo root.
Required: DATABASE_URL, BETTER_AUTH_SECRET (≥32 chars; falls back to SESSION_SECRET if unset), GOOGLE_TOKEN_ENCRYPTION_KEY (base64 32 bytes).
Google OAuth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
Feature flags: GOOGLE_ANALYTICS_ENABLED, GOOGLE_SEARCH_CONSOLE_ENABLED, GOOGLE_ADSENSE_ENABLED (default true), GOOGLE_AD_MANAGER_ENABLED (default false).
Sync intervals: SYNC_GA4_HISTORICAL_MINUTES, SYNC_SEARCH_CONSOLE_HOURS, SYNC_ADSENSE_HOURS, SYNC_AD_MANAGER_HOURS — targets, not guarantees.
Package manager: pnpm 12.21.0; Node >= 26. Never commit `.env` or real credentials.
