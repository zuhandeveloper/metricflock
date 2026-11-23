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
