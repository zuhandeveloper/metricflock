# Google API Enablement
Enable in Google Cloud Console → APIs & Services → Library:
- Analytics Data API (GA4 reports)
- Google Analytics Admin API (property discovery)
- Search Console API (search performance, sitemaps, URL inspection)
- AdSense Management API (earnings reports)
- Ad Manager API (optional; only if GOOGLE_AD_MANAGER_ENABLED=true)
Quotas: GA4 Data API has per-property daily/per-minute quotas; Search Console has row limits (25,000 rows, pagination); AdSense report dimensions/metrics cannot all be combined — check the API docs before adding a new combination.
