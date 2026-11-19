import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function MyTeamPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const memberships = await prisma.teamMember.findMany({ where: { userId: user.id }, include: { team: { include: { websites: { select: { id: true, name: true, domain: true, status: true } }, members: { include: { user: { select: { email: true } } } } } } } });
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">My Team</h1>
      {memberships.length === 0 ? <EmptyState title="You are not in a team yet" hint="Ask a Super Admin or Team Admin to add you." /> : memberships.map((m) => (
        <Card key={m.id} className="p-4"><h2 className="font-semibold">{m.team.name}</h2>
          <p className="text-sm text-zinc-500">{m.team.members.length} members · {m.team.websites.length} websites</p>
          <ul className="mt-2 space-y-1 text-sm">{m.team.websites.map((w) => <li key={w.id}>{w.name} ({w.domain}) — {w.status}</li>)}</ul>
        </Card>))}
    </div>
  );
}
