# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository
owner (GitHub: @zuhandeveloper) — do not open a public issue with
exploit details. Include the affected route/component, reproduction
steps, and impact. You should receive an acknowledgement within a
few days.

## Security model (summary)

Full detail: `docs/security/overview.md`. In short:

- **Authentication**: better-auth (email + password with mandatory
  email verification, Google sign-in, TOTP two-factor). Passwords
  ≥12 chars; reset revokes all sessions.
- **Tenancy**: every resource is organization-scoped; cross-tenant
  access returns 404 (never 403-with-details). Team membership and
  per-website assignments narrow access further.
- **Google tokens**: AES-256-GCM encrypted at rest with a versioned
  envelope + per-connection AAD; rotation supported
  (`docs/token-encryption-rotation.md`).
- **OAuth flows**: server-persisted single-use state, session-bound,
  PKCE (S256), owner validated at connect and callback.
- **Audit**: sign-ins, role changes, transfers, disconnects and
  requeues are audit-logged with actor + IP; credential-shaped fields
  are scrubbed before storage.
- **Transport/headers**: CSP, HSTS, X-Frame-Options DENY, nosniff,
  Referrer-Policy, Permissions-Policy on every response.

## Supported versions

Only the latest `main` is supported. Security fixes land on a
feature branch with CI verification before merge.
