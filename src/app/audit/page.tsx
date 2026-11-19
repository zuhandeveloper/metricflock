import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, EmptyState } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function AuditPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") return <Card className="p-6"><h1 className="text-lg font-bold">Permission denied</h1><p className="text-sm text-zinc-500">Audit logs are visible to Super Admins only.</p></Card>;
  const logs = await prisma.auditLog.findMany({ where: { organizationId: user.organizationId }, include: { actor: { select: { email: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Audit Log</h1>
      <Card className="p-4">{logs.length === 0 ? <EmptyState title="No audit entries yet" /> : (
        <table className="w-full text-sm"><thead><tr className="text-left text-zinc-500"><th className="py-2">Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
        <tbody>{logs.map((l) => <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800"><td className="py-2">{l.createdAt.toISOString()}</td><td>{l.actor?.email ?? "system"}</td><td>{l.action}</td><td>{l.entityType ?? "—"} {l.entityId ?? ""}</td></tr>)}</tbody></table>)}
      </Card>
    </div>
  );
}
