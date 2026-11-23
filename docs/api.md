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
- Limit: **120 requests/minute per key** (`429 rate_limited` beyond that).
- Revoke a key any time from the same settings page; revocation is immediate.
- Responses are served from synced snapshots — API calls never trigger
  live Google requests, so data freshness follows your sync schedule.

## Endpoints

### `GET /api/v1/websites`

Your organization's websites (max 500): `id`, `name`, `domain`, `url`,
`status`, `teamId`, `createdAt`.

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

JSON with an `error` code: `unauthorized` (401, missing/invalid/revoked
key), `rate_limited` (429), `invalid_report` / `invalid_provider`
(400), `website_not_found` (404).
