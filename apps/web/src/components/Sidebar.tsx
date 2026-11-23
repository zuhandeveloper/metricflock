"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Globe,
  Users,
  Plug,
  ArrowLeftRight,
  ScrollText,
  LogOut,
  BarChart3,
  ShieldCheck,
  Mail,
  RefreshCw,
  UserPlus,
  HeartPulse,
  TrendingUp,
} from "lucide-react";
const links = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/websites", label: "Websites", icon: Globe },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/members", label: "Members", icon: UserPlus },
  { href: "/team", label: "My Team", icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/health", label: "Health", icon: HeartPulse },
  { href: "/insights", label: "Insights", icon: TrendingUp },
  { href: "/transfers", label: "Transfers", icon: ArrowLeftRight },
  { href: "/sync", label: "Sync jobs", icon: RefreshCw, superAdminOnly: true },
  { href: "/audit", label: "Audit Log", icon: ScrollText },
  { href: "/settings/security", label: "Account security", icon: ShieldCheck },
  { href: "/settings/reports", label: "Weekly reports", icon: Mail, superAdminOnly: true },
];
export type SidebarUser = { name: string | null; email: string; role: string };
export default function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <Link
        href="/dashboard"
        className="mb-4 flex items-center gap-2 rounded-lg px-2 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
      >
        <img src="/logo.svg" alt="MetricFlock" width={32} height={32} className="rounded-lg" />
        <span className="text-lg font-bold">MetricFlock</span>
      </Link>
      {links
        .filter((l) => !l.superAdminOnly || user.role === "SUPER_ADMIN")
        .map((l) => {
          const Icon = l.icon;
          const active = pathname === l.href || pathname.startsWith(l.href + "/");
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${active ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
            >
              <Icon size={16} aria-hidden="true" />
              {l.label}
            </Link>
          );
        })}
      <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="px-3 pb-2">
          <p className="truncate text-sm font-medium">{user.name ?? user.email}</p>
          <p className="truncate text-xs text-zinc-500">
            {user.email} · {user.role}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-50 dark:hover:bg-zinc-800"
        >
          <LogOut size={16} aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </nav>
  );
}
