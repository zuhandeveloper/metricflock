import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Organization data export (Phase 4, F-4.3 —
// docs/security/data-lifecycle.md). SUPER_ADMIN only
// (organization.manage). The export is an operational archive: org
// structure, members, websites, mappings and transfer history.
// Credentials are NEVER included — no password hashes, no encrypted
// Google tokens, no session data.
async function get(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage");
  if ("error" in auth) return auth.error;
  const orgId = auth.user.organizationId;

  const [organization, members, teams, websites, connections, transfers] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true, email: true, role: true, emailVerified: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.team.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        members: { select: { userId: true, isAdmin: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.website.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        name: true,
        domain: true,
        url: true,
        description: true,
        status: true,
        teamId: true,
        purchaseDate: true,
        saleDate: true,
        purchasePrice: true,
        salePrice: true,
        notes: true,
        createdAt: true,
        assignments: { select: { userId: true } },
        integrations: {
          select: {
            provider: true,
            externalId: true,
            resourceName: true,
            mappingStatus: true,
            isPrimary: true,
            googleConnection: { select: { googleAccountEmail: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.googleConnection.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        googleAccountEmail: true,
        scopes: true,
        status: true,
        teamId: true,
        websiteId: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.websiteTransfer.findMany({
      where: { website: { organizationId: orgId } },
      select: {
        id: true,
        websiteId: true,
        fromTeamId: true,
        toTeamId: true,
        status: true,
        reason: true,
        initiatedAt: true,
        completedAt: true,
      },
      orderBy: { initiatedAt: "asc" },
    }),
  ]);

  await writeAudit({
    organizationId: orgId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "organization.exported",
    entityType: "Organization",
    entityId: orgId,
    details: { members: members.length, websites: websites.length },
  });

  const payload = {
    exportedAt: new Date().toISOString(),
    organization,
    members,
    teams,
    websites,
    connections,
    transfers,
  };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="metricflock-${organization?.slug ?? "organization"}-export.json"`,
    },
  });
}

export const GET = withApiErrors("organization/export", get);
