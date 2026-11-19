# Property Mapping Guide
1. Connect a Google account (team-level or website-level) from `/integrations`.
2. Click discover (POST `/api/google/properties/discover`) — lists GA4 properties, Search Console sites, AdSense accounts the account can access.
3. Map a property to a website (POST `/api/google/properties/map` with provider + externalId). One primary mapping per provider per website.
4. Only mapped, authorized properties return data. Unmapped properties return `status: "missing_data"`.
5. Resolution order: website connection first, then team connection. Credentials are never merged.
