# Google Cloud Setup Guide

1. Go to Google Cloud Console → create a project.
2. Enable APIs: Analytics Data API, Google Analytics Admin API, Search Console API, AdSense Management API. (Ad Manager API only if `GOOGLE_AD_MANAGER_ENABLED=true`.)
3. APIs & Services → Credentials → Create OAuth client ID (Web application).
4. Add authorized redirect URI exactly matching `GOOGLE_REDIRECT_URI` (see `docs/redirect-uri.md`).
5. Configure the OAuth consent screen: app name, support email, scopes (analytics.readonly, webmasters.readonly, adsense.readonly), add test users while in Testing mode.
6. For production: submit the app for Google verification; until verified, only test users can authorize and refresh tokens may expire after 7 days.
7. Copy Client ID/Secret into `.env` — never commit them.
