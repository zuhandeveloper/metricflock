import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
beforeAll(() => {
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
});
import {
  encryptToken,
  decryptToken,
  hashToken,
  hmacState,
  verifyHmacState,
  needsReencryption,
} from "@metricflock/shared";
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
describe("versioned envelope + key rotation (OAUTH-7)", () => {
  it("writes the v1 envelope and round-trips with AAD", () => {
    const enc = encryptToken("tok", "mf-conn:org:TEAM:team:a@b.c");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptToken(enc, "mf-conn:org:TEAM:team:a@b.c")).toBe("tok");
    expect(needsReencryption(enc)).toBe(false);
  });
  it("fails when the AAD does not match (ciphertext transplant)", () => {
    const enc = encryptToken("tok", "mf-conn:org:TEAM:team:a@b.c");
    expect(() => decryptToken(enc, "mf-conn:org:TEAM:other:a@b.c")).toThrow();
  });
  it("decrypts legacy (pre-v1) ciphertexts and flags them for re-encryption", () => {
    const key = Buffer.from(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY!, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("legacy-tok", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
    expect(decryptToken(legacy)).toBe("legacy-tok");
    expect(needsReencryption(legacy)).toBe(true);
  });
  it("decrypts old-key ciphertexts during a rotation window", () => {
    const keyA = crypto.randomBytes(32).toString("base64");
    const keyB = crypto.randomBytes(32).toString("base64");
    const savedCurrent = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    const savedPrevious = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    try {
      process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = keyA;
      delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
      const oldCiphertext = encryptToken("rotating-tok", "aad");
      // Rotate: B becomes current, A becomes previous.
      process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = keyB;
      process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS = keyA;
      expect(decryptToken(oldCiphertext, "aad")).toBe("rotating-tok");
      expect(needsReencryption(oldCiphertext)).toBe(true);
      const newCiphertext = encryptToken("rotating-tok", "aad");
      expect(needsReencryption(newCiphertext)).toBe(false);
      // After the window closes (previous removed), old ciphertext is unreadable.
      delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
      expect(() => decryptToken(oldCiphertext, "aad")).toThrow("TOKEN_KEY_UNKNOWN");
    } finally {
      if (savedCurrent !== undefined) process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = savedCurrent;
      if (savedPrevious !== undefined) process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS = savedPrevious;
      else delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    }
  });
});
describe("verifyHmacState (OAUTH-3)", () => {
  it("accepts a valid signature and rejects others", () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "x".repeat(40);
    try {
      const sig = hmacState("payload");
      expect(verifyHmacState("payload", sig)).toBe(true);
      expect(verifyHmacState("other", sig)).toBe(false);
      expect(verifyHmacState("payload", "short")).toBe(false);
      expect(verifyHmacState("payload", "0".repeat(64))).toBe(false);
    } finally {
      if (saved !== undefined) process.env.SESSION_SECRET = saved;
      else delete process.env.SESSION_SECRET;
    }
  });
});
describe("hmacState (OAuth state signing) fails closed", () => {
  it("throws when SESSION_SECRET is missing", () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect(() => hmacState("payload")).toThrow(/SESSION_SECRET/);
    } finally {
      if (saved !== undefined) process.env.SESSION_SECRET = saved;
    }
  });
  it("throws when SESSION_SECRET is too short", () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "short";
    try {
      expect(() => hmacState("payload")).toThrow(/SESSION_SECRET/);
    } finally {
      if (saved !== undefined) process.env.SESSION_SECRET = saved;
      else delete process.env.SESSION_SECRET;
    }
  });
  it("signs deterministically with a valid secret", () => {
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "x".repeat(40);
    try {
      expect(hmacState("payload")).toBe(hmacState("payload"));
      expect(hmacState("payload")).not.toBe(hmacState("other"));
    } finally {
      if (saved !== undefined) process.env.SESSION_SECRET = saved;
      else delete process.env.SESSION_SECRET;
    }
  });
});
