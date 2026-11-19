import type { Metadata } from "next";
import "./globals.css";
import QueryProvider from "@/components/QueryProvider";
import Sidebar from "@/components/Sidebar";
import ThemeToggle from "@/components/ThemeToggle";
export const metadata: Metadata = {
  title: "MetricFlock",
  description: "Your whole website portfolio, in one dashboard. Multi-website Google Analytics, Search Console, AdSense and Ad Manager management.",
  metadataBase: new URL("https://metricflock.com"),
  icons: { icon: [{ url: "/favicon.ico" }, { url: "/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/favicon-16.png", sizes: "16x16", type: "image/png" }], apple: "/apple-touch-icon.png" },
  manifest: "/site.webmanifest",
  openGraph: { title: "MetricFlock", description: "Your whole website portfolio, in one dashboard.", url: "https://metricflock.com", siteName: "MetricFlock", images: [{ url: "/og.png", width: 1200, height: 630, alt: "MetricFlock — your whole website portfolio, in one dashboard." }], type: "website" },
  twitter: { card: "summary_large_image", title: "MetricFlock", description: "Your whole website portfolio, in one dashboard.", images: ["/twitter-card.png"] },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <QueryProvider>
          <div className="flex min-h-screen">
            <aside className="hidden w-60 shrink-0 border-r border-zinc-200 dark:border-zinc-800 md:block"><Sidebar /></aside>
            <main className="min-w-0 flex-1">
              <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <span className="text-sm text-zinc-500">Multi-website Analytics &amp; Publisher Management</span>
                <ThemeToggle />
              </header>
              <div className="p-4 md:p-6">{children}</div>
            </main>
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
