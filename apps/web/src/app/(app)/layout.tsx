import { redirect } from "next/navigation";
import { getSessionUser, isPlatformAdmin } from "@metricflock/auth";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import ThemeToggle from "@/components/ThemeToggle";
import TwoFactorNudge from "@/components/TwoFactorNudge";
import TwoFactorSetupScreen from "@/components/TwoFactorSetupScreen";
import { userHasPassword } from "@/lib/has-password";
import { requiresTwoFactorSetup, shouldNudgeTwoFactor, twoFactorEnforcementEnabled } from "@/lib/two-factor-gate";
export const dynamic = "force-dynamic";
// Every page under (app) requires a session. Unauthenticated visitors are
// sent to /login before any app UI renders.
//
// A-SEC-08 (owner decision 2026-11-26): a SUPER_ADMIN without two-factor
// authentication is forced to enrol before using the app — the setup
// screen replaces page content (sidebar/sign-out still render, and the
// screen embeds the same setup component as Settings → Security, so
// there is no lock-out loop). Other roles only get a dismissible
// recommendation. The policy activates on production deployments only
// (see twoFactorEnforcementEnabled) so local dev and CI's seeded demo
// admin are not gated.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const policyActive = twoFactorEnforcementEnabled();
  const gated = policyActive && requiresTwoFactorSetup(user);
  const nudge = policyActive && shouldNudgeTwoFactor(user);
  // A Google-only SUPER_ADMIN has no password to confirm during
  // enrolment — the setup screen must know so it doesn't ask for one.
  const hasPassword = gated ? await userHasPassword(user.id) : true;
  // The platform super admin (first registered user) gets the
  // cross-organization user directory in the nav; nobody else does.
  const platformAdmin = await isPlatformAdmin(user.id);
  const sidebarUser = { name: user.name, email: user.email, role: user.role, isPlatformAdmin: platformAdmin };
  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[60] focus:rounded-lg focus:bg-zinc-900 focus:px-3 focus:py-2 focus:text-white dark:focus:bg-white dark:focus:text-zinc-900"
      >
        Skip to main content
      </a>
      <aside className="hidden w-60 shrink-0 border-r border-zinc-200 md:block dark:border-zinc-800">
        <Sidebar user={sidebarUser} />
      </aside>
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex min-w-0 items-center gap-2">
            <MobileNav user={sidebarUser} />
            <span className="truncate text-sm text-zinc-500 dark:text-zinc-400">
              Multi-website Analytics &amp; Publisher Management
            </span>
          </div>
          <ThemeToggle />
        </header>
        <div className="p-4 md:p-6">
          {gated ? (
            <TwoFactorSetupScreen hasPassword={hasPassword} />
          ) : (
            <>
              {nudge && <TwoFactorNudge />}
              {children}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
