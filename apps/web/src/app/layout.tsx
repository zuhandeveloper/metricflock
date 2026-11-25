import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
// FE-6: canonical/OG URLs derive from the deployed app URL, not a
// hardcoded domain (falls back to the production domain when unset).
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://metricflock.com";
export const metadata: Metadata = {
  title: "MetricFlock",
  description:
    "Your whole website portfolio, in one dashboard. Multi-website Google Analytics, Search Console, AdSense and Ad Manager management.",
  metadataBase: new URL(appUrl),
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/favicon.ico" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "MetricFlock",
    description: "Your whole website portfolio, in one dashboard.",
    url: appUrl,
    siteName: "MetricFlock",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "MetricFlock — your whole website portfolio, in one dashboard.",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MetricFlock",
    description: "Your whole website portfolio, in one dashboard.",
    images: ["/twitter-card.png"],
  },
};
// The app shell (sidebar/header) lives in (app)/layout.tsx so public pages
// like /login render standalone, with no app chrome visible before sign-in.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // F-6.8: reading the per-request CSP nonce opts every page into
  // dynamic rendering, so Next can stamp the nonce onto the framework
  // scripts/styles it injects (proxy.ts sets x-nonce + the CSP header).
  await headers();
  // A-FE-12: render the persisted theme server-side so reloads keep it
  // with no flash (the toggle writes the `theme` cookie).
  const dark = (await cookies()).get("theme")?.value === "dark";
  return (
    <html lang="en" className={dark ? "dark" : undefined} suppressHydrationWarning>
      {/* suppressHydrationWarning: browser extensions (e.g. Grammarly) inject
          attributes into <body> before hydration, which otherwise logs a
          hydration mismatch warning in dev. */}
      <body suppressHydrationWarning>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
