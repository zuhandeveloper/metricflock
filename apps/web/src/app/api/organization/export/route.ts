import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";

// Organization data export (Phase 4, F-4.3 —
// docs/security/data-lifecycle.md). SUPER_ADMIN only
// (organization.manage). The export is an operational archive: org
// structure, members, websites, mappings and transfer history.
// Credentials are NEVER included — no password hashes, no encrypted
// Google tokens, no session data.
//
// A-API-15: the export is capped internally — each collection returns
// at most MAX_EXPORT_ROWS rows and the payload carries `truncated` +
// `truncatedCollections` when a collection was cut. The rate-limit half
// was already covered by A-API-05 (`strict` = 20/min on requireApiAuth
// below). The export is a plain download link (OrgAdminForms), so the
// two new top-level fields break no client. A truncated export still
// writes the `organization.exported` audit row (the A-SEC-19 deletion
// gate reads it) — with `truncated: true` in the details, so the
// record shows the archive was partial.
const MAX_EXPORT_ROWS = 1000;

// Fetch one row past the cap so truncation is detected without a count
// query (same pattern as A-API-09's `truncated` flag).
function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= MAX_EXPORT_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: true };
}

async function get(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req, rateLimit: "strict" });
  if ("error" in auth) return auth.error;
  const orgId = auth.user.organizationId;

  // A-API-15: `take` is MAX_EXPORT_ROWS + 1 so capRows can detect the cut.
  const take = MAX_EXPORT_ROWS + 1;
  const [organization, members, teams, websites, connections, transfers] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, slug: true, createdAt: true },
    }),
    prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true, email: true, role: true, emailVerified: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take,
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
      take,
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
      take,
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
      take,
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
      take,
    }),
  ]);

  const capped = {
    members: capRows(members),
    teams: capRows(teams),
    websites: capRows(websites),
    connections: capRows(connections),
    transfers: capRows(transfers),
  };
  const truncatedCollections = (Object.keys(capped) as (keyof typeof capped)[]).filter((key) => capped[key].truncated);
  const truncated = truncatedCollections.length > 0;

  await writeAudit({
    organizationId: orgId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "organization.exported",
    entityType: "Organization",
    entityId: orgId,
    details: { members: capped.members.rows.length, websites: capped.websites.rows.length, truncated },
  }).catch(() => undefined); // A-API-04: audit failure must not turn an export into a 500.

  const payload = {
    exportedAt: new Date().toISOString(),
    truncated,
    truncatedCollections,
    organization,
    members: capped.members.rows,
    teams: capped.teams.rows,
    websites: capped.websites.rows,
    connections: capped.connections.rows,
    transfers: capped.transfers.rows,
  };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="metricflock-${organization?.slug ?? "organization"}-export.json"`,
    },
  });
}

export const GET = withApiErrors("organization/export", get);
