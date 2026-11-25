import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { InviteForm, RevokeInviteButton, RoleSelect, DeleteMemberButton } from "./MemberForms";
import { OrgAdminActions } from "./OrgAdminForms";
export const dynamic = "force-dynamic";

// A-FE-15: members paginated like the websites list (50/page with a
// total) — the old unbounded query loaded every org user. Pending
// invites are capped at the 50 most recent (take 51 to detect more);
// invites are transient, so a cap + note beats a second pager.
const PAGE_SIZE = 50;
export default async function MembersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // A-SEC-10: the member directory (emails + roles) and the pending
  // invites are restricted to member.manage holders. Without this gate
  // any signed-in TEAM_MEMBER could read every member's email and role.
  // Same pattern as the /sync page (EmptyState, no directory content).
  if (!hasPermission(user.role, "member.manage")) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Members</h1>
        <EmptyState
          title="Admins only"
          hint="Viewing the member directory is restricted to organization and team admins."
        />
      </div>
    );
  }
  const canManage = hasPermission(user.role, "member.manage");
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const membersWhere = { organizationId: user.organizationId };
  const [totalMembers, members, invites, organization] = await Promise.all([
    prisma.user.count({ where: membersWhere }),
    prisma.user.findMany({
      where: membersWhere,
      select: { id: true, name: true, email: true, role: true, createdAt: true, emailVerified: true },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.organizationInvite.findMany({
      where: { organizationId: user.organizationId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
    }),
    prisma.organization.findUnique({ where: { id: user.organizationId }, select: { slug: true } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalMembers / PAGE_SIZE));
  const shownInvites = invites.slice(0, PAGE_SIZE);
  const hasMoreInvites = invites.length > PAGE_SIZE;
  const pageHref = (p: number) => (p > 1 ? `/members?page=${p}` : "/members");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Members</h1>
      {canManage && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Invite a member</h2>
          <InviteForm />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Invited users join this organization with the chosen role when they sign up with the invited email. Public
            sign-ups without an invite still get their own workspace.
          </p>
        </Card>
      )}
      <Card className="p-4">
        <h2 className="font-semibold">Organization members</h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 dark:text-zinc-400">
                <th scope="col" className="py-2">
                  Member
                </th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2">
                    {m.name}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {m.email}
                      {m.id === user.id ? " (you)" : ""}
                      {m.emailVerified ? "" : " · unverified"}
                    </span>
                  </td>
                  <td>
                    {canManage && m.id !== user.id ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <RoleSelect memberId={m.id} role={m.role} canGrantSuperAdmin={user.role === "SUPER_ADMIN"} />
                        <DeleteMemberButton memberId={m.id} memberEmail={m.email} />
                      </span>
                    ) : (
                      <Badge tone={m.role === "SUPER_ADMIN" ? "blue" : m.role === "TEAM_ADMIN" ? "green" : "zinc"}>
                        {m.role}
                      </Badge>
                    )}
                  </td>
                  <td className="text-xs text-zinc-500 dark:text-zinc-400">{m.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <nav aria-label="Members pagination" className="mt-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages} · {totalMembers} members
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
      </Card>
      {canManage && (
        <Card className="p-4">
          <h2 className="font-semibold">Pending invites</h2>
          {shownInvites.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">No pending invites.</p>
          ) : (
            <>
              <ul className="mt-2 space-y-1 text-sm">
                {shownInvites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {i.email} · {i.role} · expires {i.expiresAt.toISOString().slice(0, 10)}
                    </span>
                    <RevokeInviteButton inviteId={i.id} />
                  </li>
                ))}
              </ul>
              {hasMoreInvites && (
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  Showing the {PAGE_SIZE} most recent pending invites.
                </p>
              )}
            </>
          )}
        </Card>
      )}
      {user.role === "SUPER_ADMIN" && organization && (
        <Card className="p-4">
          <h2 className="font-semibold">Organization</h2>
          <div className="mt-3">
            <OrgAdminActions orgSlug={organization.slug} />
          </div>
        </Card>
      )}
    </div>
  );
}
