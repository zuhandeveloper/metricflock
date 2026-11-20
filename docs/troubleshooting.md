# Troubleshooting

- `google_oauth_not_configured`: set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI.
- `redirect_uri_mismatch`: redirect URI in Cloud Console must match exactly.
- `no_refresh_token`: re-authorize; Google only issues a refresh token on first consent (we use prompt=consent).
- `CONNECTION_REQUIRED` / `not_connected`: connect an account and map a property.
- `google_quota_exceeded` (429): back off; BullMQ retries with exponential backoff. Check quota in Cloud Console.
- `MISSING_REFRESH_TOKEN`: connection needs reauthorization.
- Build fails on Prisma: run `npx prisma generate` (requires DATABASE_URL at generate time only as a placeholder — the client is lazy).
- No Redis: caching/queues degrade to no-ops; manual sync still works via `/api/sync`.

## Prisma engine downloads behind a proxy

In this sandbox the egress proxy resets Prisma CLI's internal engine downloads
(`ECONNRESET` from `binaries.prisma.sh`). Workaround used here (Prisma 7, pnpm):

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
