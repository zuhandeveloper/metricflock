import type { NextConfig } from "next";

// CI-2: security headers on every response. The Content-Security-Policy
// itself is set per-request in src/proxy.ts (Phase 6, F-6.8): script-src
// uses a fresh nonce + 'strict-dynamic' instead of 'unsafe-inline', and
// img-src is narrowed to 'self' data:. The static headers below stay
// here because they never change.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // A-SEC-13: no legitimate cross-origin embed or opener use exists
  // (no iframes, no window.open/popups; Google sign-in is a full-page
  // redirect), so same-origin isolation is safe. X-Frame-Options: DENY
  // and CSP frame-ancestors 'none' already forbid framing entirely.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A-SEC-13: do not advertise the framework (Next defaults this to true).
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next must transpile them.
  transpilePackages: [
    "@metricflock/db",
    "@metricflock/shared",
    "@metricflock/auth",
    "@metricflock/google",
    "@metricflock/jobs",
  ],
  experimental: { optimizePackageImports: ["lucide-react", "recharts"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default nextConfig;
