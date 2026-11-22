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
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
