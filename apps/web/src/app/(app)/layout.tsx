import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import ThemeToggle from "@/components/ThemeToggle";
export const dynamic = "force-dynamic";
// Every page under (app) requires a session. Unauthenticated visitors are
// sent to /login before any app UI renders.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:rounded-lg focus:bg-zinc-900 focus:px-3 focus:py-2 focus:text-white dark:focus:bg-white dark:focus:text-zinc-900"
      >
        Skip to main content
      </a>
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 md:block dark:border-zinc-800">
        <Sidebar user={{ name: user.name, email: user.email, role: user.role }} />
      </aside>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-2">
            <MobileNav user={{ name: user.name, email: user.email, role: user.role }} />
            <span className="truncate text-sm text-zinc-500 dark:text-zinc-400">
              Multi-website Analytics &amp; Publisher Management
            </span>
          </div>
          <ThemeToggle />
        </header>
        <div className="p-4 md:p-6">{children}</div>
      </main>
    </div>
  );
}
