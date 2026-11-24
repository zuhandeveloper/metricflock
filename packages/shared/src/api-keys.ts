// API key generation (Phase 7.5). Keys look like `mf_<43 chars of
// base64url>` (32 random bytes). Only hashToken(secret) is stored;
// the prefix is kept for display so a key can be identified in the
// UI without revealing the secret.
import { randomBytes } from "node:crypto";

export const API_KEY_PREFIX = "mf_";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, 10);
}

export function isApiKeyFormat(value: string): boolean {
  return /^mf_[A-Za-z0-9_-]{43}$/.test(value);
}

// A-SEC-09 — API key scopes and expiry. The five v1 endpoints map
// to four read scopes; a key with an empty scopes list is a legacy
// key and keeps full v1 access (all scopes). A key with a non-empty
// list is restricted to exactly those scopes.
export const API_KEY_SCOPES = ["websites:read", "portfolio:read", "insights:read", "health:read"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

// Parses a caller-supplied scopes value. `undefined` means "not
// provided" (legacy full access, stored as []). Returns null when
// the value is not an array of known scopes.
export function parseApiKeyScopes(value: unknown): ApiKeyScope[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const scopes: ApiKeyScope[] = [];
  for (const entry of value) {
    if (!isApiKeyScope(entry)) return null;
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  return scopes;
}

// A-SEC-09 — expiry. A key may live at most one year; `undefined`
// (or null/empty) means "no expiry" (legacy behaviour, stored as
// null). Returns the parsed date, or an error message when the value
// is present but unusable (unparseable, in the past, or >1 year out).
export const API_KEY_MAX_EXPIRY_DAYS = 365;

export function parseApiKeyExpiry(
  value: unknown,
  now: Date = new Date(),
): { expiresAt: Date | null; error?: undefined } | { expiresAt: null; error: string } {
  if (value === undefined || value === null || value === "") return { expiresAt: null };
  const date = typeof value === "string" || value instanceof Date ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) return { expiresAt: null, error: "expiresAt must be a valid ISO date." };
  if (date.getTime() <= now.getTime()) return { expiresAt: null, error: "expiresAt must be in the future." };
  const max = now.getTime() + API_KEY_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  if (date.getTime() > max)
    return { expiresAt: null, error: `expiresAt must be within ${API_KEY_MAX_EXPIRY_DAYS} days.` };
  return { expiresAt: date };
}
