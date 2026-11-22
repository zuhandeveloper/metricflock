import { describe, it, expect } from "vitest";
import { clientIpFromHeaders } from "@metricflock/shared";

// Phase 3 (F-3.1): rate-limit keys must come from a trusted client IP,
// never the raw client-supplied header value.
function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe("clientIpFromHeaders", () => {
  it("prefers x-real-ip over x-forwarded-for", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBe(
      "203.0.113.7",
    );
  });
  it("uses only the first x-forwarded-for entry", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1, 10.0.0.2" }))).toBe(
      "198.51.100.1",
    );
  });
  it("spoofed prefixes cannot mint distinct buckets beyond the first entry", () => {
    const a = clientIpFromHeaders(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }));
    const b = clientIpFromHeaders(headers({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" }));
    expect(a).toBe(b);
  });
  it("falls back to unknown", () => {
    expect(clientIpFromHeaders(headers({}))).toBe("unknown");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "  " }))).toBe("unknown");
  });
});
