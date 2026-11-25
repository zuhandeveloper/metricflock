import { redirect } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
import { CreateTeamForm, TeamAdminControls } from "./TeamForms";
export const dynamic = "force-dynamic";
export default async function TeamsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // A-SEC-10: the team directory mirrors GET /api/teams, which requires
  // team.view — TEAM_MEMBER has no team.view, so they get the gated
  // state instead of every team's member list (emails + roles). Same
  // pattern as the /sync page (EmptyState, no directory content).
  if (!hasPermission(user.role, "team.view")) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Teams</h1>
        <EmptyState title="Admins only" hint="Viewing teams is restricted to organization and team admins." />
      </div>
    );
  }
  const canManage = hasPermission(user.role, "team.manage");
  const [teams, orgUsers] = await Promise.all([
    prisma.team.findMany({
      // A-SEC-11: same scoping as GET /api/teams — SUPER_ADMIN sees
      // every team; anyone else sees only teams they administer
      // (isAdmin membership). The team.view gate above is unchanged.
      where: {
        organizationId: user.organizationId,
        ...(user.role === "SUPER_ADMIN" ? {} : { members: { some: { userId: user.id, isAdmin: true } } }),
      },
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
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {t._count.members} members · {t._count.websites} websites
              </p>
              {/* A-SEC-10: member lists render only inside TeamAdminControls
                  (managers). The old non-manager branch listed every
                  member's email + role to anyone who could see the page;
                  with the team.view gate above, no non-manager reaches
                  this card at all, and a future team.view-only role must
                  not get the directory for free either. */}
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
