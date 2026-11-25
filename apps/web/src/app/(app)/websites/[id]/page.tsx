import { redirect, notFound } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertWebsiteAccess } from "@metricflock/auth";
import { Card, Badge } from "@/components/ui";
import DateRangePicker from "@/components/DateRangePicker";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { EditWebsiteForm, AssignForm, TransferForm, SyncNowForm, DeleteWebsiteButton } from "./WebsiteActions";
export const dynamic = "force-dynamic";
// Human labels for the SyncJobType enum values shown in the latest-sync
// line. Keep in step with SYNC_TYPES in ./WebsiteActions (the manual
// form's labels, keyed by queue name instead).
const SYNC_JOB_TYPE_LABELS: Record<string, string> = {
  GA4_REALTIME: "GA4 realtime",
  GA4_HISTORICAL: "GA4 historical",
  SEARCH_CONSOLE: "Search Console",
  ADSENSE: "AdSense",
  AD_MANAGER: "Ad Manager",
  CACHE_REFRESH: "Cache refresh",
  HEALTH_CHECK: "Health check",
  OAUTH_REFRESH: "OAuth refresh",
  PROPERTY_DISCOVERY: "Property discovery",
  SCHEDULED_REPORT: "Scheduled report",
};
export default async function WebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; assignQ?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const { range, assignQ } = await searchParams;
  const website = await assertWebsiteAccess(user, id).catch(() => null);
  if (!website) notFound();
  // A-FE-07: the latest sync job for this website (one row, bounded) so
  // the page shows whether a sync is running, failed, or never started
  // without a trip to /sync (SUPER_ADMIN only). Tenant-scoped: the
  // website was already verified via assertWebsiteAccess above, and the
  // row is keyed by that website id.
  // A-FE-15: the assign select's candidate list is capped at 50 with an
  // email search (assignQ) — the old unbounded query rendered every org
  // user as an <option>. Assignments themselves come from `full` below,
  // so capping candidates never hides an existing assignment.
  const orgUsersWhere = {
    organizationId: user.organizationId,
    ...(assignQ ? { email: { contains: assignQ, mode: "insensitive" as const } } : {}),
  };
  const [full, teams, orgUsers, totalOrgUsers, latestSync] = await Promise.all([
    prisma.website.findUnique({
      where: { id },
      include: {
        team: true,
        integrations: true,
        transfers: { orderBy: { createdAt: "desc" }, take: 5 },
        assignments: { include: { user: { select: { id: true, email: true } } } },
      },
    }),
    prisma.team.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.user.findMany({
      where: orgUsersWhere,
      select: { id: true, email: true, role: true },
      orderBy: { email: "asc" },
      take: 50,
    }),
    prisma.user.count({ where: orgUsersWhere }),
    prisma.analyticsSyncJob.findFirst({
      where: { websiteId: id },
      orderBy: { updatedAt: "desc" },
      select: { type: true, status: true, lastError: true, updatedAt: true },
    }),
  ]);
  const canManage = hasPermission(user.role, "website.manage");
  const canAssign = hasPermission(user.role, "website.assign");
  const canTransfer = hasPermission(user.role, "website.transfer");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{full?.name}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {full?.domain} · {full?.url} · Team: {full?.team?.name ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={full?.status === "ACTIVE" ? "green" : "amber"}>{full?.status}</Badge>
          <DateRangePicker />
        </div>
      </div>
      <Card className="p-4">
        <h2 className="font-semibold">Integrations</h2>
        {full?.integrations.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            No properties mapped yet. Connect a Google account on the Integrations page, discover properties, then map
            one to this website.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {full?.integrations.map((i) => (
              <li key={i.id}>
                {i.provider} — {i.externalId} {i.resourceName ? `(${i.resourceName})` : ""} · {i.mappingStatus}
                {i.isPrimary ? " · primary" : ""}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <h3 className="text-sm font-medium">Latest sync</h3>
          {latestSync ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span>{SYNC_JOB_TYPE_LABELS[latestSync.type] ?? latestSync.type}</span>
              <Badge
                tone={
                  latestSync.status === "SUCCEEDED"
                    ? "green"
                    : latestSync.status === "RUNNING"
                      ? "blue"
                      : latestSync.status === "FAILED"
                        ? "red"
                        : "amber"
                }
              >
                {latestSync.status}
              </Badge>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{latestSync.updatedAt.toISOString()}</span>
              {latestSync.lastError && (
                <span className="max-w-xs truncate text-xs text-red-700 dark:text-red-400" title={latestSync.lastError}>
                  {latestSync.lastError}
                </span>
              )}
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">No syncs yet.</p>
          )}
        </div>
        <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {canManage ? (
            <SyncNowForm websiteId={id} />
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Manual sync is available to website managers.</p>
          )}
        </div>
      </Card>
      <WebsiteAnalytics websiteId={id} range={range ?? "28d"} />
      {canManage && full && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Edit website</h2>
          <EditWebsiteForm
            websiteId={id}
            name={full.name}
            domain={full.domain}
            url={full.url}
            status={full.status}
            teamId={full.teamId}
            teams={teams}
          />
          <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <DeleteWebsiteButton websiteId={id} domain={full.domain} />
          </div>
        </Card>
      )}
      {canAssign && full && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Assigned members</h2>
          <form className="mb-3 flex flex-wrap items-center gap-2">
            {range && <input type="hidden" name="range" value={range} />}
            <label htmlFor="assign-member-search" className="sr-only">
              Search members to assign
            </label>
            <input
              id="assign-member-search"
              name="assignQ"
              defaultValue={assignQ ?? ""}
              placeholder="Search members by email…"
              className="w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
              Search
            </button>
            {totalOrgUsers > orgUsers.length && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Showing {orgUsers.length} of {totalOrgUsers} members — search to narrow the list.
              </span>
            )}
          </form>
          <AssignForm
            websiteId={id}
            assignments={full.assignments.map((a) => ({ userId: a.user.id, email: a.user.email }))}
            orgUsers={orgUsers}
          />
        </Card>
      )}
      {canTransfer && full && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Transfer ownership</h2>
          <TransferForm websiteId={id} currentTeamId={full.teamId} teams={teams} />
        </Card>
      )}
      <Card className="p-4">
        <h2 className="font-semibold">Activity / transfers</h2>
        {full?.transfers.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">No transfers recorded.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {full?.transfers.map((t) => (
              <li key={t.id}>
                {t.status} · {t.initiatedAt.toISOString()} · to team {t.toTeamId}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
