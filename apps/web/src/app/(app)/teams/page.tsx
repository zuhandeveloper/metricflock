import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
import { CreateTeamForm, TeamAdminControls } from "./TeamForms";
export const dynamic = "force-dynamic";

// A-FE-15: teams paginated like the websites list (50/page with a
// total) — the old unbounded query loaded every team with all its
// members. The add-member candidate list (orgUsers) is capped at 50
// with an email search, same as the website page's assign select, so a
// large org does not render every user as an <option> in every card.
const PAGE_SIZE = 50;
export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; memberQ?: string }>;
}) {
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
  const { page: pageParam, memberQ } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  // A-SEC-11: same scoping as GET /api/teams — SUPER_ADMIN sees
  // every team; anyone else sees only teams they administer
  // (isAdmin membership). The team.view gate above is unchanged.
  const teamsWhere = {
    organizationId: user.organizationId,
    ...(user.role === "SUPER_ADMIN" ? {} : { members: { some: { userId: user.id, isAdmin: true } } }),
  };
  const orgUsersWhere = {
    organizationId: user.organizationId,
    ...(memberQ ? { email: { contains: memberQ, mode: "insensitive" as const } } : {}),
  };
  const [totalTeams, teams, orgUsers, totalOrgUsers] = await Promise.all([
    prisma.team.count({ where: teamsWhere }),
    prisma.team.findMany({
      where: teamsWhere,
      include: {
        _count: { select: { members: true, websites: true } },
        members: { include: { user: { select: { id: true, email: true, role: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.user.findMany({
      where: orgUsersWhere,
      select: { id: true, email: true, role: true },
      orderBy: { email: "asc" },
      take: PAGE_SIZE,
    }),
    prisma.user.count({ where: orgUsersWhere }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalTeams / PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (memberQ) params.set("memberQ", memberQ);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/teams?${qs}` : "/teams";
  };
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
        <>
          {canManage && (
            <form className="flex flex-wrap items-center gap-2">
              <label htmlFor="team-member-search" className="sr-only">
                Search members to add
              </label>
              <input
                id="team-member-search"
                name="memberQ"
                defaultValue={memberQ ?? ""}
                placeholder="Search members to add by email…"
                className="w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
                Search
              </button>
              {totalOrgUsers > orgUsers.length && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Showing {orgUsers.length} of {totalOrgUsers} members in add-member lists — search to narrow.
                </span>
              )}
            </form>
          )}
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
          {totalPages > 1 && (
            <nav aria-label="Teams pagination" className="flex items-center justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">
                Page {page} of {totalPages} · {totalTeams} teams
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
    </div>
  );
}
