# Public API (v1)

Read-only access to your organization's MetricFlock data for scripts,
dashboards and other tools. Phase 7.5.

## Authentication

Create a key under **Settings → API keys** (Super Admins only). The
secret is shown once; store it safely. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer mf_your_secret_here" \
  https://metricflock.bond/api/v1/websites
```

- Keys are organization-level and **read-only**.
- Keys may carry an optional expiry and per-key scopes (A-SEC-09):
  `expiresAt` (ISO date, in the future, at most 1 year out; omitted =
  never expires) and `scopes` (subset of `websites:read`,
  `portfolio:read`, `insights:read`, `health:read`; omitted or empty =
  full v1 access, as for keys minted before scopes existed). An expired
  key is rejected with 401; a key used on an endpoint outside its
  scopes is rejected with 403 `insufficient_scope`. Endpoint scopes:
  `websites:read` → `/websites` and `/websites/:id/analytics`,
  `portfolio:read` → `/portfolio`, `insights:read` → `/insights`,
  `health:read` → `/health`. A key can be rotated from the same
  settings page (old secret stops working immediately; the replacement
  keeps the same name, scopes and expiry).
- Limit: **120 requests/minute per key** (`429 rate_limited` beyond that).
- Revoke a key any time from the same settings page; revocation is immediate.
- Responses are served from synced snapshots — API calls never trigger
  live Google requests, so data freshness follows your sync schedule.

## Endpoints

### `GET /api/v1/websites`

Your organization's websites: `id`, `name`, `domain`, `url`, `status`,
`teamId`, `createdAt`. Paginated with `limit` (default 500, max 500)
and `offset`; the response carries `pagination: { total, limit, offset }`
and `truncated: true` when the org has more websites than the page holds.

### `GET /api/v1/websites/:id/analytics?report=overview&range=28d`

One website's report payload from the latest snapshot.

- `report`: `overview`, `traffic`, `audience`, `pages`, `events`
  (GA4), `search-console`, `adsense`, `ad-manager`.
- `range`: `today`, `yesterday`, `7d`, `28d` (default), `90d`, `12m`.
- `status` is `ok`, `no_property_mapped` (nothing mapped for that
  provider) or `no_snapshot_yet` (sync has not produced this range).
- `stale: true` means the snapshot is past its freshness window but is
  still the latest available data.

### `GET /api/v1/portfolio?provider=GA4&report=overview&range=28d`

Portfolio totals across all websites (rates recomputed from summed
totals; underivable metrics are `null` with an explanation in
`totalsNote`). `provider`: `GA4`, `SEARCH_CONSOLE`, `ADSENSE`,
`AD_MANAGER`. `includedWebsites` / `unavailableWebsites` say exactly
which websites contributed.

### `GET /api/v1/health?page=1`

Integration health: summary counts (healthy / error / stale /
without record) plus a page of per-integration rows.

### `GET /api/v1/insights`

SEO/revenue insights: per-website striking-distance and low-CTR
queries, earnings patterns, channel mix, and portfolio summary
(total earnings, blended RPM, earnings per 1k sessions).

## Errors

JSON with an `error` code: `unauthorized` (401, missing/invalid/revoked/expired
key), `insufficient_scope` (403, key lacks the endpoint's scope),
`rate_limited` (429), `invalid_report` / `invalid_provider`
(400), `website_not_found` (404).
