# OAuth Guide

How MetricFlock connects Google accounts (team-level or website-level) and
keeps their tokens safe.

## Connect flow

```mermaid
sequenceDiagram
    actor User
    participant Web as MetricFlock web
    participant DB as PostgreSQL
    participant Google as Google OAuth

    User->>Web: GET /api/google/oauth/connect (owner: team or website)
    Web->>DB: Persist OAuthState (single-use, session-bound) + PKCE verifier
    Web-->>User: 302 redirect to Google consent (S256 challenge)
    User->>Google: Authorize (offline access, consent prompt)
    Google-->>Web: GET /api/google/oauth/callback?code=…&state=…
    Web->>DB: Atomically consume state; verify session user matches
    Web->>Google: Exchange code + PKCE verifier for tokens
    Web->>DB: Store tokens AES-256-GCM encrypted (v1 envelope, AAD-bound)
    Web-->>User: Redirect to /integrations?oauth=connected
```

- **Flow**: Authorization Code with `access_type=offline`,
  `prompt=consent`, `include_granted_scopes=true`.
- **State**: server-persisted in the `OAuthState` table, single-use
  (atomically consumed on callback), bound to the signed-in user and to
  the connection owner (team/website), validated against the caller's
  organization at connect _and_ callback. The connect endpoint redirects
  (302) to Google — it never returns the auth URL as JSON.
- **PKCE**: S256 code challenge on every flow.
- **Scopes** (least privilege, read-only):
  `analytics.readonly`, `webmasters.readonly`, `adsense.readonly`.
  Request more only when a feature needs them.

## Token storage & refresh

- Access and refresh tokens are encrypted at rest with **AES-256-GCM**
  (`GOOGLE_TOKEN_ENCRYPTION_KEY`, base64 of 32 bytes) in a versioned
  envelope `v1:<keyId>:<base64(iv|tag|data)>`, with the connection identity
  as AAD and the auth tag length pinned to 16 bytes. Rotation:
  `docs/token-encryption-rotation.md`. Tokens are never logged.
- Refresh is serialized **per connection** with a Redis lock plus a
  double-check, so concurrent requests can't race a refresh.
- Only a structured `invalid_grant` from Google marks a connection
  `REVOKED` (and writes an audit entry); transient errors keep the
  connection alive for the next attempt.

## Callback outcomes

The callback always redirects back to the app with a status query param:

| Param                    | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `oauth=connected`        | Connection saved and active                                                           |
| `oauth=login_required`   | No signed-in session at callback time                                                 |
| `oauth=session_mismatch` | Callback session user ≠ the user who started the flow                                 |
| `oauth=no_refresh_token` | Google returned no refresh token (existing authorization) — re-authorize with consent |
| `oauth=error`            | Anything else; check server logs by requestId                                         |

## Disconnect

Disconnect (Integrations page, or `POST /api/google/connections/disconnect`)
revokes the token at Google and clears the stored tokens locally. Mappings
made under the connection stop returning data until a new connection is
mapped.

## Rate limits

Connect and callback endpoints are rate-limited (Redis limiter) on top of
better-auth's auth-endpoint limits, so OAuth endpoints can't be hammered
to burn quota or brute-force state values.

## Related

- `docs/google-cloud-setup.md` — project, client and consent-screen setup
- `docs/api-enablement.md` — APIs that must be enabled, error codes
- `docs/property-mapping.md` — discovery + mapping after connecting
- `docs/security/overview.md` — the full security model
