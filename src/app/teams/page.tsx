import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function TeamsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const teams = await prisma.team.findMany({ where: { organizationId: user.organizationId }, include: { _count: { select: { members: true, websites: true } }, members: { include: { user: { select: { email: true, role: true } } } } }, orderBy: { createdAt: "desc" } });
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Teams</h1>
      {teams.length === 0 ? <EmptyState title="No teams yet" hint="Super Admins create teams via POST /api/teams." /> : (
        <div className="grid gap-4 md:grid-cols-2">{teams.map((t) => (
          <Card key={t.id} className="p-4"><h2 className="font-semibold">{t.name}</h2>
            <p className="text-sm text-zinc-500">{t._count.members} members · {t._count.websites} websites</p>
            <ul className="mt-2 space-y-1 text-sm">{t.members.map((m) => <li key={m.id}>{m.user.email} · {m.user.role}{m.isAdmin ? " (team admin)" : ""}</li>)}</ul>
          </Card>))}</div>)}
    </div>
  );
}
