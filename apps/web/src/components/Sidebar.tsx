"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Globe, Users, Plug, ArrowLeftRight, ScrollText, LogIn, BarChart3 } from "lucide-react";
const links = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/websites", label: "Websites", icon: Globe },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/team", label: "My Team", icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/transfers", label: "Transfers", icon: ArrowLeftRight },
  { href: "/audit", label: "Audit Log", icon: ScrollText },
];
export default function Sidebar() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 p-3">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-2">
        <img src="/logo.svg" alt="MetricFlock" width={32} height={32} className="rounded-lg" />
        <span className="text-lg font-bold">MetricFlock</span>
      </Link>
      {links.map((l) => {
        const Icon = l.icon;
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
          >
            <Icon size={16} />
            {l.label}
          </Link>
        );
      })}
      <Link
        href="/login"
        className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <LogIn size={16} />
        Sign in
      </Link>
    </nav>
  );
}
