import { describe, it, expect } from "vitest";
import { clientIpFromHeaders } from "@metricflock/shared";

// Phase 3 (F-3.1): rate-limit keys must come from a trusted client IP,
// never the raw client-supplied header value. A-SEC-05: headers are only
// trusted when a proxy that overwrites them sits in front of the app —
// the header-parsing cases below run with trust enabled explicitly;
// without trust the headers are ignored entirely (see the last test).
function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe("clientIpFromHeaders", () => {
  it("prefers x-real-ip over x-forwarded-for", () => {
    expect(
      clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), {
        trustProxy: true,
      }),
    ).toBe("203.0.113.7");
  });
  it("uses only the first x-forwarded-for entry", () => {
    expect(
      clientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1, 10.0.0.2" }), {
        trustProxy: true,
      }),
    ).toBe("198.51.100.1");
  });
  it("spoofed prefixes cannot mint distinct buckets beyond the first entry", () => {
    const a = clientIpFromHeaders(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), { trustProxy: true });
    const b = clientIpFromHeaders(headers({ "x-forwarded-for": "1.1.1.1, 9.9.9.9" }), { trustProxy: true });
    expect(a).toBe(b);
  });
  it("falls back to unknown", () => {
    expect(clientIpFromHeaders(headers({}), { trustProxy: true })).toBe("unknown");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "  " }), { trustProxy: true })).toBe("unknown");
  });
  it("ignores spoofed headers entirely when the proxy is not trusted", () => {
    expect(
      clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }), {
        trustProxy: false,
      }),
    ).toBe("unknown");
  });
});
