import { prisma } from "@metricflock/db";
import type { User } from "@metricflock/db";
// Server-side tenant isolation. Never trust org/team/website IDs from the browser
// without a DB ownership + permission check. Frontend visibility is not security.
export async function assertTeamAccess(user: User, teamId: string) {
  if (user.role === "SUPER_ADMIN") {
    const team = await prisma.team.findFirst({ where: { id: teamId, organizationId: user.organizationId } });
    if (!team) throw new Error("NOT_FOUND_OR_FORBIDDEN");
    return team;
  }
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: user.id }, include: { team: true } });
  if (!membership || membership.team.organizationId !== user.organizationId) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  if (user.role === "TEAM_ADMIN" && !membership.isAdmin) throw new Error("FORBIDDEN");
  return membership.team;
}
export async function assertWebsiteAccess(user: User, websiteId: string) {
  const website = await prisma.website.findFirst({ where: { id: websiteId, organizationId: user.organizationId } });
  if (!website) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  if (user.role === "SUPER_ADMIN") return website;
  // isAdmin membership is authoritative: a team admin of the website's
  // team can access it. Mere membership (or a global TEAM_ADMIN role
  // without isAdmin) is NOT enough — that mismatch previously let any
  // TEAM_ADMIN member open every website of their teams.
  if (website.teamId) {
    const membership = await prisma.teamMember.findFirst({ where: { teamId: website.teamId, userId: user.id } });
    if (membership?.isAdmin) return website;
  }
  // An explicit per-website assignment grants access regardless of role.
  const assignment = await prisma.websiteAssignment.findFirst({ where: { websiteId, userId: user.id } });
  if (assignment) return website;
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
}
// Manage-level website access (e.g. connecting a Google account): SUPER_ADMIN
// or isAdmin of the website's team. An assignment alone (view-level) is not
// enough to change a website's integrations.
export async function assertWebsiteManageAccess(user: User, websiteId: string) {
  const website = await prisma.website.findFirst({ where: { id: websiteId, organizationId: user.organizationId } });
  if (!website) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  if (user.role === "SUPER_ADMIN") return website;
  if (website.teamId) {
    const membership = await prisma.teamMember.findFirst({ where: { teamId: website.teamId, userId: user.id } });
    if (membership?.isAdmin) return website;
  }
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
}
// Validates that `user` may manage a Google connection owned by the given
// team/website, in the user's own organization. Used at OAuth connect time
// and re-checked at callback time (membership may change in between).
export async function assertConnectionOwnerAccess(user: User, ownerType: "TEAM" | "WEBSITE", ownerId: string) {
  if (ownerType === "TEAM") return assertTeamAccess(user, ownerId);
  return assertWebsiteManageAccess(user, ownerId);
}
export async function listAccessibleWebsiteIds(user: User): Promise<string[] | null> {
  if (user.role === "SUPER_ADMIN") return null; // null = all in org
  // Mirrors assertWebsiteAccess exactly: websites of teams where the user
  // is an admin, plus explicitly assigned websites. (Previously every
  // team website was listed for any member, so list endpoints exposed
  // websites the detail endpoint would deny.)
  const adminMemberships = await prisma.teamMember.findMany({
    where: { userId: user.id, isAdmin: true },
    select: { teamId: true },
  });
  const ids = new Set<string>();
  const teamIds = adminMemberships.map((m) => m.teamId);
  if (teamIds.length > 0) {
    const teamWebsites = await prisma.website.findMany({
      where: { organizationId: user.organizationId, teamId: { in: teamIds } },
      select: { id: true },
    });
    for (const w of teamWebsites) ids.add(w.id);
  }
  const assignments = await prisma.websiteAssignment.findMany({
    where: { userId: user.id },
    select: { websiteId: true },
  });
  for (const a of assignments) ids.add(a.websiteId);
  return [...ids];
}
