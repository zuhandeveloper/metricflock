import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState, Badge } from "@/components/ui";
import TransferActions from "./TransferActions";
export const dynamic = "force-dynamic";
export default async function TransfersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const transfers = await prisma.websiteTransfer.findMany({
    where: { website: { organizationId: user.organizationId } },
    include: {
      website: { select: { name: true, domain: true } },
      fromTeam: { select: { name: true } },
      toTeam: { select: { name: true } },
      initiatedBy: { select: { email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const adminTeamIds = new Set(
    (
      await prisma.teamMember.findMany({
        where: { userId: user.id, isAdmin: true },
        select: { teamId: true },
      })
    ).map((m) => m.teamId),
  );
  const isSuperAdmin = user.role === "SUPER_ADMIN";
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Website Transfers</h1>
      <Card className="p-4">
        <p className="text-sm text-zinc-500">
          Transfers are two-sided: the destination team&apos;s admin accepts, connects their own Google account, then
          completes — the website moves only at completion. OAuth tokens never move between owners; old property
          mappings are cleared at handover and the new team re-maps. Open transfers expire after 7 days. Historical
          reports and audit logs are preserved.
        </p>
      </Card>
      <Card className="p-4">
        {transfers.length === 0 ? (
          <EmptyState
            title="No transfers yet"
            hint="Super Admins initiate transfers via POST /api/websites/[id]/transfer."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th scope="col" className="py-2">
                  Website
                </th>
                <th scope="col">From → To</th>
                <th scope="col">Status</th>
                <th scope="col">By</th>
                <th scope="col">Initiated</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 font-medium">{t.website.name}</td>
                  <td>
                    {t.fromTeam?.name ?? "—"} → {t.toTeam.name}
                  </td>
                  <td>
                    <Badge
                      tone={
                        t.status === "COMPLETED"
                          ? "green"
                          : t.status === "CANCELLED" || t.status === "EXPIRED" || t.status === "FAILED"
                            ? "zinc"
                            : "amber"
                      }
                    >
                      {t.status}
                    </Badge>
                  </td>
                  <td>{t.initiatedBy.email}</td>
                  <td>{t.initiatedAt.toISOString().slice(0, 10)}</td>
                  <td>
                    <TransferActions
                      transferId={t.id}
                      status={t.status}
                      canDestination={isSuperAdmin || adminTeamIds.has(t.toTeamId)}
                      canCancel={isSuperAdmin || t.initiatedById === user.id}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
