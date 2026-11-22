// Value-level secret redaction (Phase 6, F-6.7). Key-name scrubbing
// alone (the old audit behavior) misses secrets embedded INSIDE
// strings — provider error messages, URLs, log lines. These helpers
// redact secret-shaped substrings wherever free text is stored,
// emailed, or logged. Patterns target the credential shapes this app
// actually handles (Google OAuth tokens, JWTs, bearer headers,
// key=value secrets, OAuth URLs, our own token envelope) rather than
// generic entropy heuristics, to keep false positives near zero.

const REDACTED = "[REDACTED]";

const PATTERNS: { re: RegExp; replace: (m: string, ...groups: string[]) => string }[] = [
  // Google OAuth access tokens.
  { re: /ya29\.[A-Za-z0-9._~+/=-]+/g, replace: () => REDACTED },
  // Google OAuth refresh tokens (1//...), not part of a URL scheme.
  { re: /(?<![\w:/])1\/\/[A-Za-z0-9._~+/=-]{10,}/g, replace: () => REDACTED },
  // JWTs (three base64url segments, header starts with eyJ).
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: () => REDACTED },
  // Bearer authorization values.
  { re: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replace: (_m, prefix: string) => `${prefix}${REDACTED}` },
  // Our encrypted-token envelope: v1:<keyId>:<base64...>.
  { re: /v1:[A-Za-z0-9_-]+:[A-Za-z0-9+/=_-]{16,}/g, replace: () => REDACTED },
  // Secret-bearing URL query parameters (OAuth codes/tokens in URLs).
  {
    re: /([?&](?:access_token|refresh_token|id_token|client_secret|api_key|apikey|code|token)=)[^&\s"']+/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  // key=value / key: value secrets in free text and JSON-ish strings.
  // The lookahead leaves "Authorization: Bearer <token>" to the Bearer
  // pattern above instead of redacting the word Bearer itself.
  {
    re: /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|credential)["']?\s*[:=]\s*["']?)(?![Bb]earer\s)[^\s"',}&]+/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
];

/** Redact secret-shaped substrings from free text. Non-secret text —
 * error codes, IDs, ordinary URLs — passes through unchanged. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace as (...args: unknown[]) => string);
  return out;
}

/** The one way provider/error text should reach storage, email, or
 * logs: message extracted, secrets redacted, length bounded. */
export function sanitizeProviderError(e: unknown, maxLength = 500): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redactSecrets(msg).slice(0, maxLength);
}
