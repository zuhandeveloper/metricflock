# Redirect URI Setup
- Development: `http://localhost:3000/api/google/oauth/callback`
- Production: `https://<your-domain>/api/google/oauth/callback`
- The value must match `GOOGLE_REDIRECT_URI` in `.env` and the authorized redirect URI in Google Cloud Console exactly (scheme, host, port, path). A mismatch returns `redirect_uri_mismatch`.
