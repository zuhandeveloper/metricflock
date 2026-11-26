import { prisma } from "@metricflock/db";
// Platform super admin (owner decision 2026-11-26): the FIRST registered
// user on the platform — earliest `createdAt`, tie-broken by `id` — is the
// platform admin. That one user can list every user across all
// organizations and change any user's role within that user's own
// organization (see /admin/users and /api/admin/users/[id]). Everyone else
// stays scoped to their own organization.
//
// Computed dynamically on every call — no schema flag. If the first user
// is ever deleted, the next-earliest user becomes platform admin.
export async function getPlatformAdminId(): Promise<string | null> {
  const first = await prisma.user.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return first?.id ?? null;
}
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  return (await getPlatformAdminId()) === userId;
}
