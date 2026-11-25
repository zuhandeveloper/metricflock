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
// Manage-level team access: SUPER_ADMIN (org-scoped) or an isAdmin member
// of the team. Used wherever a caller must be able to administer the team
// itself (e.g. creating a website in it, or moving a website into it) —
// mere membership is not enough, regardless of the caller's global role.
export async function assertTeamManageAccess(user: User, teamId: string) {
  const team = await prisma.team.findFirst({ where: { id: teamId, organizationId: user.organizationId } });
  if (!team) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  if (user.role === "SUPER_ADMIN") return team;
  const membership = await prisma.teamMember.findFirst({ where: { teamId, userId: user.id } });
  if (membership?.isAdmin) return team;
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
}
// Connection↔website ownership scope: a connection may only serve websites
// inside its own ownership scope — a team connection serves websites of
// that team; a website connection serves that website. Enforced when a
// property is mapped (the write that binds a connection to a website), so
// one team's Google credentials can never be bound to another team's
// website, even by an org admin. Throws NOT_FOUND_OR_FORBIDDEN.
export function assertConnectionScopeForWebsite(
  conn: { teamId: string | null; websiteId: string | null },
  website: { id: string; teamId: string | null },
) {
  // A-DB-08: typed FKs are the only authority. The legacy polymorphic
  // columns are deliberately NOT consulted — a row whose legacy owner
  // disagrees with its typed FKs must not be interpretable by either
  // value, and the `GoogleConnection_legacy_owner_match_check` CHECK
  // guarantees they agree in the database. A connection with neither
  // typed FK set serves nothing.
  const connTeamId = conn.teamId;
  const connWebsiteId = conn.websiteId;
  if (connTeamId) {
    if (website.teamId === connTeamId) return;
    throw new Error("NOT_FOUND_OR_FORBIDDEN");
  }
  if (connWebsiteId) {
    if (website.id === connWebsiteId) return;
    throw new Error("NOT_FOUND_OR_FORBIDDEN");
  }
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
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
// Connection visibility (audit AUTH-8/API-3): SUPER_ADMIN sees every
// connection in the organization. Everyone else sees only connections
// owned by teams they administer, or by websites in those teams. Returns
// a Prisma `where` fragment; combine with organizationId at the call site.
export async function connectionVisibilityWhere(user: User) {
  if (user.role === "SUPER_ADMIN") return {};
  const adminMemberships = await prisma.teamMember.findMany({
    where: { userId: user.id, isAdmin: true },
    select: { teamId: true },
  });
  const teamIds = adminMemberships.map((m) => m.teamId);
  return {
    OR: [{ teamId: { in: teamIds } }, { website: { teamId: { in: teamIds } } }],
  };
}
// Single-connection visibility check (disconnect/discover): same rule as
// connectionVisibilityWhere, applied to one loaded connection. Throws
// NOT_FOUND_OR_FORBIDDEN so foreign connections are indistinguishable
// from missing ones.
export async function assertConnectionVisible(user: User, conn: { teamId: string | null; websiteId: string | null }) {
  if (user.role === "SUPER_ADMIN") return;
  const adminMemberships = await prisma.teamMember.findMany({
    where: { userId: user.id, isAdmin: true },
    select: { teamId: true },
  });
  const teamIds = new Set(adminMemberships.map((m) => m.teamId));
  if (conn.teamId && teamIds.has(conn.teamId)) return;
  if (conn.websiteId) {
    const website = await prisma.website.findFirst({
      where: { id: conn.websiteId, organizationId: user.organizationId },
      select: { teamId: true },
    });
    if (website?.teamId && teamIds.has(website.teamId)) return;
  }
  throw new Error("NOT_FOUND_OR_FORBIDDEN");
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
