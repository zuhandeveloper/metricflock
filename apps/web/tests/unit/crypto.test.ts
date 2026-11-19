import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
beforeAll(() => { process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); });
import { encryptToken, decryptToken, hashToken } from "@metricflock/shared";
describe("AES-256-GCM token encryption", () => {
  it("round-trips a refresh token", () => {
    const enc = encryptToken("1//refresh-token-secret");
    expect(enc).not.toContain("refresh-token-secret");
    expect(decryptToken(enc)).toBe("1//refresh-token-secret");
  });
  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    expect(encryptToken("abc")).not.toBe(encryptToken("abc"));
  });
  it("fails on tampered ciphertext (auth tag)", () => {
    const enc = encryptToken("abc");
    const tampered = enc.slice(0, -4) + "AAAA";
    expect(() => decryptToken(tampered)).toThrow();
  });
  it("hashes session tokens deterministically without revealing them", () => {
    expect(hashToken("tok")).toBe(hashToken("tok"));
    expect(hashToken("tok")).not.toContain("tok");
  });
});
