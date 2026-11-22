import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-min-32-chars-long!!";
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/google/oauth/callback";
});
import { signStateNonce, parseState, createPkcePair } from "@metricflock/google/oauth";
describe("OAuth state signing (Stage 3)", () => {
  it("round-trips a nonce through sign/parse", () => {
    const nonce = crypto.randomBytes(32).toString("hex");
    expect(parseState(signStateNonce(nonce))).toEqual({ nonce });
  });
  it("rejects tampered state", () => {
    const s = signStateNonce("abc123");
    const tampered = s.slice(0, -2) + "AA";
    expect(() => parseState(tampered)).toThrow("INVALID_STATE");
  });
  it("rejects garbage and forged payloads", () => {
    expect(() => parseState("not-a-state")).toThrow("INVALID_STATE");
    const forged = Buffer.from(
      JSON.stringify({ payload: JSON.stringify({ nonce: "x" }), sig: "0".repeat(64) }),
    ).toString("base64url");
    expect(() => parseState(forged)).toThrow("INVALID_STATE");
  });
  it("rejects a signature of the wrong length without throwing a compare error", () => {
    const forged = Buffer.from(JSON.stringify({ payload: JSON.stringify({ nonce: "x" }), sig: "short" })).toString(
      "base64url",
    );
    expect(() => parseState(forged)).toThrow("INVALID_STATE");
  });
});
describe("PKCE (OAUTH-5)", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"));
  });
  it("generates unique pairs", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});
