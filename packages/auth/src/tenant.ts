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
  if (website.teamId) {
    const membership = await prisma.teamMember.findFirst({ where: { teamId: website.teamId, userId: user.id } });
    if (membership) {
      if (user.role === "TEAM_ADMIN" && membership.isAdmin) return website;
      if (user.role === "TEAM_MEMBER") {
        const assignment = await prisma.websiteAssignment.findFirst({ where: { websiteId, userId: user.id } });
        if (assignment) return website;
      }
      if (user.role === "TEAM_ADMIN") return website; // team admin sees team websites
    }
  }
  if (user.role === "TEAM_MEMBER") {
    const assignment = await prisma.websiteAssignment.findFirst({ where: { websiteId, userId: user.id } });
    if (assignment) return website;
  }
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
}
export async function listAccessibleWebsiteIds(user: User): Promise<string[] | null> {
  if (user.role === "SUPER_ADMIN") return null; // null = all in org
  const memberships = await prisma.teamMember.findMany({ where: { userId: user.id }, select: { teamId: true, isAdmin: true } });
  const teamIds = memberships.map((m) => m.teamId);
  const teamWebsites = await prisma.website.findMany({ where: { organizationId: user.organizationId, teamId: { in: teamIds } }, select: { id: true } });
  const ids = new Set(teamWebsites.map((w) => w.id));
  if (user.role === "TEAM_ADMIN") return [...ids];
  const assignments = await prisma.websiteAssignment.findMany({ where: { userId: user.id }, select: { websiteId: true } });
  for (const a of assignments) ids.add(a.websiteId);
  return [...ids];
}
