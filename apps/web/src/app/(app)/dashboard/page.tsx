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
      select: { provider: true, mappingStatus: true, websiteId: true },
    }),
  ]);
  // DATA-4: a website counts as connected only when IT has a mapped
  // integration — not when any integration in the org is mapped.
  const connected = websites.filter((w) =>
    integrations.some((i) => i.websiteId === w.id && i.mappingStatus === "MAPPED"),
  ).length;
  // FE-4: per-website last successful sync (one windowed groupBy).
  const lastSyncRows = await prisma.analyticsSyncJob.groupBy({
    by: ["websiteId"],
    where: {
      status: "SUCCEEDED",
      websiteId: { in: websites.map((w) => w.id) },
      updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
    },
    _max: { updatedAt: true },
  });
  const lastSyncByWebsite = new Map(lastSyncRows.map((r) => [r.websiteId, r._max.updatedAt]));
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
      {teams === 0 && (
        <Card className="p-4">
          <h2 className="font-semibold">Get started</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>
              <Link href="/teams" className="text-blue-600 hover:underline">
                Create a team
              </Link>{" "}
              — websites and Google connections attach to teams.
            </li>
            <li>
              <Link href="/websites" className="text-blue-600 hover:underline">
                Add a website
              </Link>{" "}
              to the team.
            </li>
            <li>
              <Link href="/integrations" className="text-blue-600 hover:underline">
                Connect a Google account
              </Link>
              , discover its properties, and map them to the website.
            </li>
          </ol>
        </Card>
      )}
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
                <th scope="col" className="py-2">
                  Website
                </th>
                <th scope="col">Team</th>
                <th scope="col">Status</th>
                <th scope="col">Last synced</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
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
                  <td className="text-zinc-500">
                    {lastSyncByWebsite.get(w.id)?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}
                  </td>
                  <td className="text-right">
                    <Link
                      href={`/websites/${w.id}`}
                      className="rounded text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                    >
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
