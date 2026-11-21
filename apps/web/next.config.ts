import type { NextConfig } from "next";

// CI-2: security headers on every response. The CSP is pragmatic for a
// Next.js + Recharts app: Next injects inline bootstrap scripts/styles
// (hence 'unsafe-inline'), charts render as inline SVG (no eval needed),
// images may come from Google avatars. Tightening script-src further
// requires nonce plumbing — tracked as future work.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
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
