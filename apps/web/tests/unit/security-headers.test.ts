import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

// A-SEC-13: the framework header must stay off and the security headers
// must stay complete. The smoke script checks headers live in CI; this
// test pins the config itself so a config edit cannot silently drop a
// header without failing the unit suite.

const EXPECTED_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

describe("security headers (next.config)", () => {
  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("sets every expected security header on all paths", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const routes = await nextConfig.headers!();
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe("/:path*");
    const byKey = new Map(routes[0].headers.map((h) => [h.key, h.value]));
    for (const [key, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(byKey.get(key)).toBe(value);
    }
  });
});
