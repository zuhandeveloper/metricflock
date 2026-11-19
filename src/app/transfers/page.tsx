import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState, Badge } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function TransfersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const transfers = await prisma.websiteTransfer.findMany({ where: { website: { organizationId: user.organizationId } }, include: { website: { select: { name: true, domain: true } }, fromTeam: { select: { name: true } }, toTeam: { select: { name: true } }, initiatedBy: { select: { email: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Website Transfers</h1>
      <Card className="p-4"><p className="text-sm text-zinc-500">Transfers never move OAuth tokens between owners. The new team must connect its own Google account, discover and map properties, and confirm connection health before the transfer is marked completed. Historical reports and audit logs are preserved.</p></Card>
      <Card className="p-4">
        {transfers.length === 0 ? <EmptyState title="No transfers yet" hint="Super Admins initiate transfers via POST /api/websites/[id]/transfer." /> : (
          <table className="w-full text-sm"><thead><tr className="text-left text-zinc-500"><th className="py-2">Website</th><th>From → To</th><th>Status</th><th>By</th><th>Initiated</th></tr></thead>
          <tbody>{transfers.map((t) => <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
            <td className="py-2 font-medium">{t.website.name}</td><td>{t.fromTeam?.name ?? "—"} → {t.toTeam.name}</td>
            <td><Badge tone={t.status === "COMPLETED" ? "green" : "amber"}>{t.status}</Badge></td><td>{t.initiatedBy.email}</td><td>{t.initiatedAt.toISOString().slice(0, 10)}</td></tr>)}</tbody></table>)}
      </Card>
    </div>
  );
}
