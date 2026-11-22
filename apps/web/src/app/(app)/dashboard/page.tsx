import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { MetricCard, Card, Badge, EmptyState } from "@/components/ui";
import DateRangePicker from "@/components/DateRangePicker";
import { loadPortfolio } from "@/lib/portfolio";
import { resolveRange } from "@/lib/analytics-response";
import Link from "next/link";
export const dynamic = "force-dynamic";

// Phase 5 (F-5.6): every query on this page is bounded. Counts come
// from COUNT/groupBy aggregates (never "load all rows and filter in
// JS"), and the website table is paginated — at 10k websites the old
// shape loaded every website + integration row and scanned O(W×I).
const PAGE_SIZE = 50;
const CONNECTIONS_SHOWN = 50;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; page?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { range, page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const ids = await listAccessibleWebsiteIds(user);
  const websiteWhere =
    ids === null ? { organizationId: user.organizationId } : { organizationId: user.organizationId, id: { in: ids } };
  const [
    totalWebsites,
    websites,
    teams,
    members,
    connectionTotal,
    connectionActive,
    connections,
    connected,
    providerCounts,
  ] = await Promise.all([
    prisma.website.count({ where: websiteWhere }),
    prisma.website.findMany({
      where: websiteWhere,
      include: { team: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.team.count({ where: { organizationId: user.organizationId } }),
    prisma.user.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.count({ where: { organizationId: user.organizationId, status: "ACTIVE" } }),
    prisma.googleConnection.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, googleAccountEmail: true, status: true, ownerType: true },
      orderBy: { createdAt: "desc" },
      take: CONNECTIONS_SHOWN,
    }),
    // DATA-4: a website counts as connected only when IT has a mapped
    // integration — one COUNT with a relation filter, not a JS scan.
    prisma.website.count({
      where: { ...websiteWhere, integrations: { some: { mappingStatus: "MAPPED" } } },
    }),
    prisma.websiteIntegration.groupBy({
      by: ["provider"],
      where: { website: websiteWhere },
      _count: { _all: true },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalWebsites / PAGE_SIZE));
  const byProvider = new Map(providerCounts.map((r) => [r.provider, r._count._all]));
  // FE-4: per-website last successful sync (one windowed groupBy over
  // just this page's websites).
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
  // Phase 7.1 — portfolio totals from per-website snapshots (no live
  // fan-out). The range matches the worker's 28-day sync window by
  // default, so synced snapshots are found without extra Google calls.
  const { startDate: pfStart, endDate: pfEnd } = resolveRange(range ?? "28d");
  const [pfGa4, pfSc, pfAds] = await Promise.all([
    loadPortfolio(user, { provider: "GA4", source: "ga4", report: "overview", startDate: pfStart, endDate: pfEnd }),
    loadPortfolio(user, {
      provider: "SEARCH_CONSOLE",
      source: "search-console",
      report: "search-console",
      startDate: pfStart,
      endDate: pfEnd,
    }),
    loadPortfolio(user, {
      provider: "ADSENSE",
      source: "adsense",
      report: "adsense",
      startDate: pfStart,
      endDate: pfEnd,
    }),
  ]);
  const fmtNum = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US");
  const fmtMoney = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const topBySessions = pfGa4.websites
    .map((w) => ({
      ...w,
      sessions: ((w.payload as { summary?: Record<string, unknown> })?.summary?.sessions as number | null) ?? null,
    }))
    .sort((a, b) => (b.sessions ?? -1) - (a.sessions ?? -1))
    .slice(0, 10);
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (range) params.set("range", range);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/dashboard?${qs}` : "/dashboard";
  };
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
        <MetricCard label="Total websites" value={String(totalWebsites)} />
        <MetricCard
          label="Connected websites"
          value={String(connected)}
          sub={`${totalWebsites - connected} without a mapped property`}
        />
        <MetricCard label="Teams" value={String(teams)} />
        <MetricCard label="Members" value={String(members)} />
        <MetricCard label="Google accounts" value={String(connectionTotal)} sub={`${connectionActive} active`} />
        <MetricCard label="GA4 mappings" value={String(byProvider.get("GA4") ?? 0)} />
        <MetricCard label="Search Console" value={String(byProvider.get("SEARCH_CONSOLE") ?? 0)} />
        <MetricCard label="AdSense" value={String(byProvider.get("ADSENSE") ?? 0)} />
      </div>
      <Card className="p-4">
        <h2 className="font-semibold">Portfolio totals ({range ?? "28d"})</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Summed from per-website snapshots — websites without a snapshot yet are excluded, never counted as zero.
        </p>
        {pfGa4.websites.length === 0 && pfSc.websites.length === 0 && pfAds.websites.length === 0 ? (
          <EmptyState
            title="No snapshots yet"
            hint="Portfolio totals appear after the first sync or after a website's analytics are viewed once."
          />
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard
                label="Sessions (GA4)"
                value={fmtNum(pfGa4.totals?.sessions)}
                sub={`${pfGa4.websites.length} websites included`}
              />
              <MetricCard label="Active users (GA4)" value={fmtNum(pfGa4.totals?.activeUsers)} />
              <MetricCard label="Page views (GA4)" value={fmtNum(pfGa4.totals?.screenPageViews)} />
              <MetricCard
                label="Search clicks"
                value={fmtNum(pfSc.totals?.clicks)}
                sub={`${fmtNum(pfSc.totals?.impressions)} impressions`}
              />
              <MetricCard label="Est. earnings (AdSense)" value={fmtMoney(pfAds.totals?.ESTIMATED_EARNINGS)} />
            </div>
            {topBySessions.length > 0 && (
              <table className="mt-4 w-full text-sm">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1 font-medium">Top websites by sessions</th>
                    <th className="py-1 text-right font-medium">Sessions</th>
                    <th className="py-1 text-right font-medium">Snapshot</th>
                  </tr>
                </thead>
                <tbody>
                  {topBySessions.map((w) => (
                    <tr key={w.websiteId} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="py-1">
                        <Link href={`/websites/${w.websiteId}`} className="text-blue-600 hover:underline">
                          {w.name}
                        </Link>{" "}
                        <span className="text-zinc-500">{w.domain}</span>
                        {w.stale && (
                          <Badge>
                            <span>stale</span>
                          </Badge>
                        )}
                      </td>
                      <td className="py-1 text-right">{fmtNum(w.sessions)}</td>
                      <td className="py-1 text-right text-zinc-500">{w.snapshotUpdatedAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Websites</h2>
        {totalWebsites === 0 ? (
          <EmptyState
            title="No websites yet"
            hint="Add a website, then connect a Google account and map its properties."
          />
        ) : (
          <>
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
            {totalPages > 1 && (
              <nav aria-label="Websites pagination" className="mt-3 flex items-center justify-between text-sm">
                <span className="text-zinc-500">
                  Page {page} of {totalPages} · {totalWebsites} websites
                </span>
                <span className="flex gap-2">
                  {page > 1 && (
                    <Link
                      href={pageHref(page - 1)}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      ← Previous
                    </Link>
                  )}
                  {page < totalPages && (
                    <Link
                      href={pageHref(page + 1)}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      Next →
                    </Link>
                  )}
                </span>
              </nav>
            )}
          </>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Google connections</h2>
        {connectionTotal === 0 ? (
          <EmptyState
            title="No Google accounts connected"
            hint="Connect a team or website Google account from Integrations."
          />
        ) : (
          <>
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
            {connectionTotal > CONNECTIONS_SHOWN && (
              <p className="mt-2 text-xs text-zinc-500">
                Showing the {CONNECTIONS_SHOWN} most recent of {connectionTotal} connections — manage all of them from{" "}
                <Link href="/integrations" className="text-blue-600 hover:underline">
                  Integrations
                </Link>
                .
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
