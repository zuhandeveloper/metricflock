import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { MetricCard, Card, Badge, EmptyState } from "@/components/ui";
import DateRangePicker from "@/components/DateRangePicker";
import Link from "next/link";
export const dynamic = "force-dynamic";
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { range } = await searchParams;
  const ids = await listAccessibleWebsiteIds(user);
  const websiteWhere =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  const [websites, teams, members, connections, integrations] = await Promise.all([
    prisma.website.findMany({
      where: websiteWhere,
      include: { team: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.team.count({ where: { organizationId: user.organizationId } }),
    prisma.user.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, googleAccountEmail: true, status: true, ownerType: true },
    }),
    prisma.websiteIntegration.findMany({
      where: { website: { organizationId: user.organizationId } },
      select: { provider: true, mappingStatus: true },
    }),
  ]);
  const connected = websites.filter((w) => integrations.some((i) => i.mappingStatus === "MAPPED")).length;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{user.role === "SUPER_ADMIN" ? "Super Admin Dashboard" : "Dashboard"}</h1>
          <p className="text-sm text-zinc-500">
            Signed in as {user.email} ({user.role}). Range: {range ?? "28d"} — live Google metrics load per website;
            unconnected sites are listed as unavailable, never as zero.
          </p>
        </div>
        <DateRangePicker />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Total websites" value={String(websites.length)} />
        <MetricCard
          label="Connected websites"
          value={String(connected)}
          sub={`${websites.length - connected} without a mapped property`}
        />
        <MetricCard label="Teams" value={String(teams)} />
        <MetricCard label="Members" value={String(members)} />
        <MetricCard
          label="Google accounts"
          value={String(connections.length)}
          sub={`${connections.filter((c) => c.status === "ACTIVE").length} active`}
        />
        <MetricCard label="GA4 mappings" value={String(integrations.filter((i) => i.provider === "GA4").length)} />
        <MetricCard
          label="Search Console"
          value={String(integrations.filter((i) => i.provider === "SEARCH_CONSOLE").length)}
        />
        <MetricCard label="AdSense" value={String(integrations.filter((i) => i.provider === "ADSENSE").length)} />
      </div>
      <Card className="p-4">
        <h2 className="font-semibold">Websites</h2>
        {websites.length === 0 ? (
          <EmptyState
            title="No websites yet"
            hint="Add a website, then connect a Google account and map its properties."
          />
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-2">Website</th>
                <th>Team</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {websites.map((w) => (
                <tr key={w.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 font-medium">
                    {w.name}
                    <span className="block text-xs text-zinc-500">{w.domain}</span>
                  </td>
                  <td>{w.team?.name ?? "—"}</td>
                  <td>
                    <Badge tone={w.status === "ACTIVE" ? "green" : w.status === "PENDING_SETUP" ? "amber" : "zinc"}>
                      {w.status}
                    </Badge>
                  </td>
                  <td className="text-right">
                    <Link href={`/websites/${w.id}`} className="text-blue-600 hover:underline">
                      Open analytics →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Google connections</h2>
        {connections.length === 0 ? (
          <EmptyState
            title="No Google accounts connected"
            hint="Connect a team or website Google account from Integrations."
          />
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {connections.map((c) => (
              <li key={c.id} className="flex justify-between gap-2">
                <span>
                  {c.googleAccountEmail} <span className="text-zinc-500">({c.ownerType})</span>
                </span>
                <Badge tone={c.status === "ACTIVE" ? "green" : "amber"}>{c.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
