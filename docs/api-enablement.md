# Google API Enablement

Enable these APIs in the **same Google Cloud project that owns your OAuth
client** (the project number is the prefix of the Client ID:
`<project-number>-….apps.googleusercontent.com`).

| API                            | Service name                    | Used for                                                          | Library link                                                                          |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Google Analytics **Admin** API | `analyticsadmin.googleapis.com` | GA4 property discovery                                            | [Enable](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com) |
| Google Analytics **Data** API  | `analyticsdata.googleapis.com`  | GA4 realtime + historical reports                                 | [Enable](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com)  |
| Google Search Console API      | `searchconsole.googleapis.com`  | Search performance, sitemaps, URL inspection                      | [Enable](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com)  |
| AdSense Management API         | `adsense.googleapis.com`        | Earnings reports                                                  | [Enable](https://console.cloud.google.com/apis/library/adsense.googleapis.com)        |
| Ad Manager API                 | `admanager.googleapis.com`      | Ad reporting (optional; only if `GOOGLE_AD_MANAGER_ENABLED=true`) | [Enable](https://console.cloud.google.com/apis/library/admanager.googleapis.com)      |

## How to enable

1. Open the Library link above (make sure the project selector at the top
   shows the OAuth client's project).
2. Click **Enable**.
3. Confirm the API page says **"API Enabled"**.

> ⚠️ Saving **API key restrictions** does **not** enable an API — that only
> limits which APIs a key may call. And **"Google Analytics API" is not
> the Admin API**: discovery needs _Google Analytics Admin API_, reports
> need _Google Analytics Data API_. Both are required for GA4.

## What happens when an API is disabled

MetricFlock classifies per-provider failures instead of swallowing them.
Discovery and analytics responses carry one of these codes, and the UI
shows a hint per provider:

| Code                    | Meaning                                                         | Fix                                                                          |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `api_not_enabled`       | The API is not enabled in the OAuth client's project            | Enable it via the Library links above                                        |
| `permission_denied`     | The connected Google account can't access that property/account | Grant access in GA4 / Search Console / AdSense, or connect the right account |
| `unauthorized`          | Token invalid, revoked, or missing scopes                       | Reconnect the Google account (Integrations → Disconnect → Connect)           |
| `google_quota_exceeded` | Provider quota hit (HTTP 429)                                   | Back off; check sync intervals and quota in Cloud Console                    |
| `invalid_request`       | Google rejected the report shape (a bug, not config)            | Check the server logs by requestId; report it                                |
| `provider_error`        | Anything else from Google                                       | Check the server logs by requestId                                           |

## Quotas worth knowing

- **GA4 Data API** — per-property daily and per-minute token quotas;
  realtime calls are the hungriest. `SYNC_GA4_REALTIME_SECONDS` defaults
  to 300 s with coalescing + backpressure — lower it only if quota allows.
- **Search Console API** — 25,000 rows per query; MetricFlock paginates.
- **AdSense Management API** — not every dimension/metric combination is
  valid; check the API docs before adding a new report combination.
