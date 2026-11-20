import type { Metadata } from "next";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
export const metadata: Metadata = {
  title: "MetricFlock",
  description: "Your whole website portfolio, in one dashboard. Multi-website Google Analytics, Search Console, AdSense and Ad Manager management.",
  metadataBase: new URL("https://metricflock.com"),
  icons: { icon: [{ url: "/logo.svg", type: "image/svg+xml" }, { url: "/favicon.ico" }, { url: "/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/favicon-16.png", sizes: "16x16", type: "image/png" }], apple: "/apple-touch-icon.png" },
  manifest: "/site.webmanifest",
  openGraph: { title: "MetricFlock", description: "Your whole website portfolio, in one dashboard.", url: "https://metricflock.com", siteName: "MetricFlock", images: [{ url: "/og.png", width: 1200, height: 630, alt: "MetricFlock — your whole website portfolio, in one dashboard." }], type: "website" },
  twitter: { card: "summary_large_image", title: "MetricFlock", description: "Your whole website portfolio, in one dashboard.", images: ["/twitter-card.png"] },
};
// The app shell (sidebar/header) lives in (app)/layout.tsx so public pages
// like /login render standalone, with no app chrome visible before sign-in.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
