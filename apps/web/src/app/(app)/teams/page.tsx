import { redirect } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
import { CreateTeamForm, TeamAdminControls } from "./TeamForms";
export const dynamic = "force-dynamic";
export default async function TeamsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const canManage = hasPermission(user.role, "team.manage");
  const [teams, orgUsers] = await Promise.all([
    prisma.team.findMany({
      where: { organizationId: user.organizationId },
      include: {
        _count: { select: { members: true, websites: true } },
        members: { include: { user: { select: { id: true, email: true, role: true } } } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, email: true, role: true },
      orderBy: { email: "asc" },
    }),
  ]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Teams</h1>
      {canManage && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Create team</h2>
          <CreateTeamForm />
        </Card>
      )}
      {teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          hint={
            canManage ? "Create your first team above, then add websites to it." : "Ask a Super Admin to create a team."
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {teams.map((t) => (
            <Card key={t.id} className="p-4">
              <h2 className="font-semibold">{t.name}</h2>
              <p className="text-sm text-zinc-500">
                {t._count.members} members · {t._count.websites} websites
              </p>
              {!canManage && (
                <ul className="mt-2 space-y-1 text-sm">
                  {t.members.map((m) => (
                    <li key={m.id}>
                      {m.user.email} · {m.user.role}
                      {m.isAdmin ? " (team admin)" : ""}
                    </li>
                  ))}
                </ul>
              )}
              {canManage && (
                <TeamAdminControls
                  teamId={t.id}
                  teamName={t.name}
                  members={t.members.map((m) => ({
                    userId: m.user.id,
                    email: m.user.email,
                    role: m.user.role,
                    isAdmin: m.isAdmin,
                  }))}
                  orgUsers={orgUsers}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
