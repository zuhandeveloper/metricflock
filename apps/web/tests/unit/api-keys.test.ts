import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  apiKeyDisplayPrefix,
  isApiKeyFormat,
  hashToken,
  parseApiKeyScopes,
  parseApiKeyExpiry,
  API_KEY_MAX_EXPIRY_DAYS,
} from "@metricflock/shared";

describe("API keys (Phase 7.5)", () => {
  it("generates well-formed, unique secrets", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(isApiKeyFormat(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(apiKeyDisplayPrefix(a)).toBe(a.slice(0, 10));
  });

  it("rejects malformed keys", () => {
    expect(isApiKeyFormat("")).toBe(false);
    expect(isApiKeyFormat("mf_short")).toBe(false);
    expect(isApiKeyFormat(`xx_${"a".repeat(43)}`)).toBe(false);
  });

  it("hashes deterministically for storage lookup", () => {
    const key = generateApiKey();
    expect(hashToken(key)).toBe(hashToken(key));
    expect(hashToken(key)).not.toContain(key);
  });

  // A-SEC-09 — scope and expiry validation.
  it("parseApiKeyScopes: undefined → legacy full access; unknown scope → null", () => {
    expect(parseApiKeyScopes(undefined)).toEqual([]);
    expect(parseApiKeyScopes(["websites:read", "health:read"])).toEqual(["websites:read", "health:read"]);
    expect(parseApiKeyScopes(["websites:read", "websites:read"])).toEqual(["websites:read"]); // deduped
    expect(parseApiKeyScopes(["websites:read", "admin:write"])).toBeNull();
    expect(parseApiKeyScopes("websites:read")).toBeNull();
    expect(parseApiKeyScopes([42])).toBeNull();
  });

  it("parseApiKeyExpiry: absent → null; past/unparseable/too far → error", () => {
    const now = new Date("2026-11-24T10:00:00.000Z");
    expect(parseApiKeyExpiry(undefined, now)).toEqual({ expiresAt: null });
    expect(parseApiKeyExpiry(null, now)).toEqual({ expiresAt: null });
    expect(parseApiKeyExpiry("", now)).toEqual({ expiresAt: null });
    expect(parseApiKeyExpiry("not-a-date", now).error).toMatch(/valid ISO date/);
    expect(parseApiKeyExpiry("2026-11-23T10:00:00.000Z", now).error).toMatch(/in the future/);
    expect(parseApiKeyExpiry("2026-11-24T10:00:00.000Z", now).error).toMatch(/in the future/);
    const tooFar = new Date(now.getTime() + (API_KEY_MAX_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(parseApiKeyExpiry(tooFar, now).error).toMatch(/within 365 days/);
    const ok = parseApiKeyExpiry("2027-02-22T10:00:00.000Z", now);
    expect(ok.error).toBeUndefined();
    expect(ok.expiresAt?.toISOString()).toBe("2027-02-22T10:00:00.000Z");
  });
});
