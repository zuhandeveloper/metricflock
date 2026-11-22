# Google Cloud Setup Guide

MetricFlock needs one Google Cloud project with an OAuth 2.0 web client.
Everything below happens in the
[Google Cloud Console](https://console.cloud.google.com/).

## 1. Create (or pick) a project

Create a project, or reuse an existing one. **The APIs must be enabled in
the same project that owns the OAuth client** — the project number is the
prefix of your Client ID (`<project-number>-….apps.googleusercontent.com`).
If discovery returns nothing, first check you enabled the APIs in _that_
project, not a different one.

## 2. Enable the APIs

Enable these in **APIs & Services → Library** (full list and direct links:
`docs/api-enablement.md`):

- Google Analytics Admin API — property discovery
- Google Analytics Data API — GA4 reports
- Google Search Console API — search performance
- AdSense Management API — earnings reports
- Ad Manager API — only if `GOOGLE_AD_MANAGER_ENABLED=true`

> ⚠️ Two common traps:
>
> - **"Google Analytics API" ≠ "Google Analytics Admin API".** Discovery
>   needs the _Admin_ API (`analyticsadmin.googleapis.com`); reports need
>   the _Data_ API (`analyticsdata.googleapis.com`). Enabling only one
>   leaves the other failing.
> - **API key restrictions do not enable APIs.** Saving key restrictions
>   (APIs & Services → Credentials → API key) changes nothing about
>   enablement — use the Library page's **Enable** button and confirm the
>   API page shows "API Enabled".

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID →
Web application.**

- **Authorized redirect URI** must match `GOOGLE_REDIRECT_URI` _exactly_
  (scheme, host, path — no trailing slash differences). See
  `docs/redirect-uri.md`. For local development add
  `http://localhost:3000/api/google/oauth/callback` as an additional URI.
- Copy the Client ID and Client Secret into `apps/web/.env` as
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — never commit them.

## 4. Configure the consent screen

**APIs & Services → OAuth consent screen:**

- App name, support email, developer contact.
- Scopes (least privilege, read-only — MetricFlock requests exactly these):
  - `https://www.googleapis.com/auth/analytics.readonly`
  - `https://www.googleapis.com/auth/webmasters.readonly`
  - `https://www.googleapis.com/auth/adsense.readonly`
- While the app is in **Testing** mode, add every Google account that will
  connect as a **test user** — non-test users cannot authorize.

## 5. Production verification

For production use beyond test users, submit the app for Google
verification. Until verified:

- Only listed test users can authorize.
- Refresh tokens for unverified apps may expire after 7 days, which
  surfaces in MetricFlock as a connection needing reauthorization.

## 6. Verify the setup

1. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` in
   `apps/web/.env` (and in your host's env for production).
2. In MetricFlock: **Integrations → Connect Google account** → authorize.
3. Click **Discover**. You should see your GA4 properties, Search Console
   sites and AdSense accounts. If a provider shows `api_not_enabled`, go
   back to step 2 for that API (`docs/troubleshooting.md` has the full
   error-code playbook).

## Related

- `docs/api-enablement.md` — API list, direct Library links, quotas
- `docs/oauth-guide.md` — how the connect flow works under the hood
- `docs/property-mapping.md` — mapping discovered properties to websites
