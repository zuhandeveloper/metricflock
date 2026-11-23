import { describe, expect, it } from "vitest";
import { generateApiKey, apiKeyDisplayPrefix, isApiKeyFormat, hashToken } from "@metricflock/shared";

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
});
