import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import Sidebar from "@/components/Sidebar";
import ThemeToggle from "@/components/ThemeToggle";
export const dynamic = "force-dynamic";
// Every page under (app) requires a session. Unauthenticated visitors are
// sent to /login before any app UI renders.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
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
  );
}
