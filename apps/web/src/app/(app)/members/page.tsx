import { redirect } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, Badge } from "@/components/ui";
import { InviteForm, RevokeInviteButton, RoleSelect, DeleteMemberButton } from "./MemberForms";
import { OrgAdminActions } from "./OrgAdminForms";
export const dynamic = "force-dynamic";
export default async function MembersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const canManage = hasPermission(user.role, "member.manage");
  const [members, invites, organization] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, email: true, role: true, createdAt: true, emailVerified: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.organizationInvite.findMany({
      where: { organizationId: user.organizationId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.organization.findUnique({ where: { id: user.organizationId }, select: { slug: true } }),
  ]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Members</h1>
      {canManage && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Invite a member</h2>
          <InviteForm />
          <p className="mt-2 text-xs text-zinc-500">
            Invited users join this organization with the chosen role when they sign up with the invited email. Public
            sign-ups without an invite still get their own workspace.
          </p>
        </Card>
      )}
      <Card className="p-4">
        <h2 className="font-semibold">Organization members</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="py-2">Member</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-2">
                  {m.name}
                  <span className="block text-xs text-zinc-500">
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
                <td className="text-xs text-zinc-500">{m.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canManage && (
        <Card className="p-4">
          <h2 className="font-semibold">Pending invites</h2>
          {invites.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-500">No pending invites.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {i.email} · {i.role} · expires {i.expiresAt.toISOString().slice(0, 10)}
                  </span>
                  <RevokeInviteButton inviteId={i.id} />
                </li>
              ))}
            </ul>
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
