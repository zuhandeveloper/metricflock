import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next must transpile them.
  transpilePackages: ["@metricflock/db"],
  experimental: { optimizePackageImports: ["lucide-react", "recharts"] },
};
export default nextConfig;
