import { redirect } from "next/navigation";
import { getSessionUser, isPlatformAdmin } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
import { PlatformRoleSelect } from "./PlatformUserActions";
export const dynamic = "force-dynamic";

// Platform-admin user directory: the first registered user on the
// platform (see packages/auth/src/platform.ts) sees every user across
// all organizations and can change any user's role within that user's
// own organization. Everyone else gets the restricted-access state —
// no user list is loaded or leaked for them (same pattern as the
// members page's A-SEC-10 gate).
const MAX_USERS = 500;
export default async function PlatformUsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!(await isPlatformAdmin(user.id))) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Platform users</h1>
        <EmptyState title="Platform admin only" hint="This page is restricted to the platform super admin." />
      </div>
    );
  }
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      organization: { select: { name: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_USERS,
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Platform users</h1>
      <Card className="p-4">
        <h2 className="font-semibold">All users</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Every registered user across all organizations. Role changes apply within the user&apos;s own organization.
        </p>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 dark:text-zinc-400">
                <th scope="col" className="py-2">
                  User
                </th>
                <th scope="col">Organization</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2">
                    {u.name}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {u.email}
                      {u.id === user.id ? " (you)" : ""}
                    </span>
                  </td>
                  <td>{u.organization.name}</td>
                  <td>
                    <PlatformRoleSelect userId={u.id} role={u.role} disabled={u.id === user.id} />
                  </td>
                  <td className="text-xs text-zinc-500 dark:text-zinc-400">{u.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {users.length === MAX_USERS && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Showing the first {MAX_USERS} users.</p>
        )}
      </Card>
    </div>
  );
}
