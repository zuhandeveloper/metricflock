import { describe, expect, it } from "vitest";
import { redactSecrets, sanitizeProviderError } from "@metricflock/shared";

// Phase 6 (F-6.7): value-level redaction with realistic secret shapes.
describe("redactSecrets", () => {
  it("redacts Google OAuth access and refresh tokens inside free text", () => {
    const out = redactSecrets(
      "refresh failed for ya29.a0AfH6SMBx7fK9tokenValueHere and 1//0gRefreshTokenValue1234567890",
    );
    expect(out).not.toContain("ya29.");
    expect(out).not.toContain("1//0gRefreshTokenValue");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts JWTs and Bearer headers", () => {
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturePartHere";
    expect(redactSecrets(`id_token ${jwt}`)).not.toContain(jwt);
    expect(redactSecrets("Authorization: Bearer abc123.def456-ghi789")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts key=value secrets and secret-bearing URL params", () => {
    expect(redactSecrets('{"client_secret":"GOCSPX-abc123secret"}')).not.toContain("GOCSPX-abc123secret");
    expect(redactSecrets("password=Hunter2Pass!")).not.toContain("Hunter2Pass");
    const url = redactSecrets(
      "GET https://oauth2.googleapis.com/token?code=4/0AX4XfWhCodeValue&grant_type=authorization_code",
    );
    expect(url).not.toContain("4/0AX4XfWhCodeValue");
    expect(url).toContain("grant_type=authorization_code");
  });

  it("redacts our encrypted-token envelope", () => {
    expect(redactSecrets("stored v1:k1:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==")).not.toContain(
      "AbCdEfGhIjKlMnOpQrStUvWxYz",
    );
  });

  it("leaves ordinary provider errors, codes, and URLs untouched", () => {
    const clean = [
      "CONNECTION_REVOKED",
      "The caller does not have permission (403) for property 560655306",
      "GET https://analyticsdata.googleapis.com/v1beta/properties/560655306:runReport failed",
      "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'",
      "AD_MANAGER_INVALID_DATE: 2026-13-40",
    ];
    for (const s of clean) expect(redactSecrets(s)).toBe(s);
  });
});

describe("sanitizeProviderError", () => {
  it("extracts, redacts, and truncates", () => {
    const long = new Error(`boom ya29.secretTokenValue ${"x".repeat(600)}`);
    const out = sanitizeProviderError(long);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).not.toContain("ya29.");
    expect(sanitizeProviderError("plain string error")).toBe("plain string error");
    expect(sanitizeProviderError(undefined)).toBe("undefined");
  });
});
