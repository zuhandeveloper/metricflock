# Integration tests (real accounts)

Unit tests in `tests/unit/` use **mocked Google clients** and are clearly labelled as such.
They never present mocked results as live Google verification.

## Real-account integration test mode (manual, not run in CI)

Prerequisites:

- A Google Cloud project with the Analytics Data API, Search Console API and
  AdSense Management API enabled, OAuth consent screen configured, and a test
  user added (see `docs/google-cloud-setup.md`).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL` set in `.env`.
- A Postgres + Redis instance running (`POSTGRES_PASSWORD=<password from your DATABASE_URL> docker compose up -d`).

Steps:

1. `npx prisma migrate deploy && npm run db:seed`
2. Start the app (`npm run dev`), sign in as the seed admin, connect a Google
   account from `/integrations`, discover properties and map one to a website.
3. Call `GET /api/analytics/realtime?websiteId=<id>` and
   `GET /api/analytics/search-console?websiteId=<id>` and confirm `status: "ok"`
   with real rows from your own GA4 / Search Console property.
4. Transfer a website between teams and confirm the old team's members lose
   access (403) while history/audit rows remain.

Do not run these against production data or share tokens. Never commit
credentials or tokens.
