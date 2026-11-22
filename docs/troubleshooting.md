# Troubleshooting

Every API error carries a stable `error` code and a `requestId` — search
the server logs for that requestId to see the full context
(`docs/operations/observability.md`).

## Connecting Google

| Symptom / code                                    | Cause                                                   | Fix                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `google_oauth_not_configured`                     | Missing Google env vars                                 | Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`                       |
| `redirect_uri_mismatch`                           | Redirect URI differs from the Google client             | Make `GOOGLE_REDIRECT_URI` match the Cloud Console value _exactly_ (`docs/redirect-uri.md`) |
| `oauth=no_refresh_token`                          | Google issued no refresh token (existing authorization) | Re-authorize — MetricFlock uses `prompt=consent`, so disconnect and connect again           |
| `oauth=login_required` / `oauth=session_mismatch` | Session missing or different user at callback           | Sign in as the same user who started the flow, then retry                                   |
| `unauthorized` (analytics/discover)               | Token revoked/expired or scopes missing                 | Integrations → Disconnect → Connect again                                                   |
| `MISSING_REFRESH_TOKEN`                           | Stored connection has no refresh token                  | Reconnect the account                                                                       |

## Discovery returns 0 properties

The Discover UI shows a per-provider error. Work through it in order:

1. **`api_not_enabled`** — the API isn't enabled in the OAuth client's
   project. Enable it from the Library links in `docs/api-enablement.md`.
   Watch for the two classic traps: "Google Analytics API" ≠ _Google
   Analytics Admin API_, and API-key restrictions don't enable anything.
   Confirm the project: the number prefix of your Client ID
   (`<project-number>-….apps.googleusercontent.com`) must be the project
   where you clicked Enable.
2. **`permission_denied`** — the connected Google account can't see the
   property. Grant it access in GA4 (Admin → Property access), Search
   Console (Settings → Users), or AdSense — or connect the account that
   owns the property.
3. **Still 0 with no error** — the account genuinely has no properties,
   or the consent screen is in Testing mode and this account isn't a
   test user (`docs/google-cloud-setup.md` §4).

## Analytics cards show an error

| Code                          | Meaning                                             | Fix                                                                     |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `not_connected`               | No Google connection for the website/team           | Connect an account on `/integrations`                                   |
| `missing_data`                | Connected, but no property mapped for that provider | Discover + map (`docs/property-mapping.md`)                             |
| `api_not_enabled`             | API disabled in the OAuth project                   | `docs/api-enablement.md`                                                |
| `permission_denied`           | Account lost access to the mapped property          | Re-grant access or remap                                                |
| `unauthorized`                | Token revoked/expired                               | Reconnect the account                                                   |
| `google_quota_exceeded` (429) | Provider quota hit                                  | Back off; check quota in Cloud Console; consider raising sync intervals |
| `invalid_request`             | Google rejected the report shape                    | A bug — check logs by requestId and report it                           |
| `provider_error`              | Other Google-side failure                           | Check logs by requestId                                                 |

## Sync

- **"Sync now" returns `503 queue_unavailable`** — Redis isn't configured
  (`REDIS_URL` unset or unreachable). Dashboards still read live data;
  only background/manual sync needs Redis + the worker.
- **Jobs stuck in `waiting`** — the worker isn't running or is
  backlogged. Check `GET /api/metrics` queue counts and the worker's
  `/readyz`.
- **Failed jobs** — see the dead-letter view (`GET /api/sync/failed` or
  the Sync jobs page) and requeue after fixing the cause.

## Build & local dev

- **Build fails on Prisma** — run `npx prisma generate` (needs a
  placeholder `DATABASE_URL` at generate time only; the client is lazy).
- **Local dev against the production DB** — `GOOGLE_TOKEN_ENCRYPTION_KEY`
  in local `.env` must be _identical_ to production's, or stored tokens
  won't decrypt. Add the localhost redirect URI in Cloud Console.
- **`pnpm test` fails at `db#build` in restricted sandboxes** — Prisma
  engine downloads may be blocked; see below.

## Prisma engine downloads behind a proxy

In restricted sandboxes the egress proxy resets Prisma CLI's internal
engine downloads (`ECONNRESET` from `binaries.prisma.sh`). Workaround
(Prisma 7, pnpm):

1. Find the engines version + URL from the CLI debug output
   (`DEBUG="prisma:*" npx prisma validate` prints the
   `https://binaries.prisma.sh/all_commits/<hash>/debian-openssl-3.0.x/schema-engine.gz`
   URL).
2. Download with curl (which works through the proxy) and the matching
   `.sha256` file; verify the hash, gunzip, and place the binary as
   `schema-engine-debian-openssl-3.0.x` in
   `node_modules/.pnpm/@prisma+engines@<ver>/node_modules/@prisma/engines/`
   (chmod +x). The query engine lives in
   `~/.cache/prisma/master/<hash>/debian-openssl-3.0.x/` the same way.
3. Run Prisma with `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 CHECKPOINT_DISABLE=1`.
   On a normal network none of this is needed.
