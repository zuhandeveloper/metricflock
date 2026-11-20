# OAuth Guide

- Flow: Authorization Code Flow with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`.
- State: HMAC-signed, single-use-ish (10-min expiry), binds ownerType/ownerId/userId; verified on callback.
- Scopes (least privilege, read-only): analytics.readonly, webmasters.readonly, adsense.readonly. Request more only when a feature needs them.
- Refresh tokens are AES-256-GCM encrypted at rest (`GOOGLE_TOKEN_ENCRYPTION_KEY`, base64 32 bytes). Access tokens are encrypted too when persisted, never logged.
- Missing refresh token: Google may not return one for an existing authorization. The callback redirects with `?oauth=no_refresh_token`; the user must re-authorize with consent.
- Revoked/expired: refresh failures mark the connection REVOKED/NEEDS_REAUTH; the UI shows a reconnect prompt.
- Disconnect: revokes the token at Google and clears local tokens.
