import { redirect, notFound } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertWebsiteAccess } from "@metricflock/auth";
import { Card, Badge } from "@/components/ui";
import DateRangePicker from "@/components/DateRangePicker";
import WebsiteAnalytics from "@/components/WebsiteAnalytics";
import { EditWebsiteForm, AssignForm, TransferForm, SyncNowForm, DeleteWebsiteButton } from "./WebsiteActions";
export const dynamic = "force-dynamic";
export default async function WebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const { range } = await searchParams;
  const website = await assertWebsiteAccess(user, id).catch(() => null);
  if (!website) notFound();
  const [full, teams, orgUsers] = await Promise.all([
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
      where: { organizationId: user.organizationId },
      select: { id: true, email: true, role: true },
      orderBy: { email: "asc" },
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
          <p className="text-sm text-zinc-500">
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
          <p className="mt-1 text-sm text-zinc-500">
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
          <SyncNowForm websiteId={id} />
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
          <p className="mt-1 text-sm text-zinc-500">No transfers recorded.</p>
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
