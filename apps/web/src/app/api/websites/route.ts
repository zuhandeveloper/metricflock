import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError, requestIdOf } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds, assertTeamManageAccess } from "@metricflock/auth";
import { websiteCreateSchema, clientIpFromHeaders } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
import { parsePagination } from "@/lib/pagination";
async function get(req: NextRequest) {
  const auth = await requireApiAuth("website.view", { req });
  if ("error" in auth) return auth.error;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  // A-API-03: an unknown status is a client error, not a 500 — Prisma
  // rejects an invalid enum value, so validate before the query.
  const validStatuses = ["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "TRANSFER_PENDING", "SOLD", "ARCHIVED"];
  if (status && !validStatuses.includes(status)) {
    return apiError("invalid_status", 400, { status, valid: validStatuses }, requestIdOf(req));
  }
  const { limit, offset } = parsePagination(req);
  const ids = await listAccessibleWebsiteIds(auth.user);
  const where: Record<string, unknown> = {
    organizationId: auth.user.organizationId,
    ...(ids ? { id: { in: ids } } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q, mode: "insensitive" } }] }
      : {}),
  };
  const [websites, total] = await Promise.all([
    prisma.website.findMany({
      where: where as never,
      include: {
        team: { select: { name: true } },
        integrations: { select: { provider: true, mappingStatus: true, isPrimary: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.website.count({ where: where as never }),
  ]);
  return NextResponse.json({ websites, pagination: { total, limit, offset } });
}

export const GET = withApiErrors("websites", get);

async function post(req: NextRequest) {
  const auth = await requireApiAuth("website.manage", { req });
  if ("error" in auth) return auth.error;
  const body = websiteCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const d = body.data;
  // The caller must be able to MANAGE the destination team (F-1.2):
  // SUPER_ADMIN, or an isAdmin member of that team. Same-org membership
  // alone must not let a team admin create websites in other teams.
  if (d.teamId) {
    const team = await assertTeamManageAccess(auth.user, d.teamId).catch(() => null);
    if (!team) return NextResponse.json({ error: "team_not_found" }, { status: 404 });
  }
  let website;
  try {
    website = await prisma.website.create({
      data: {
        organizationId: auth.user.organizationId,
        name: d.name,
        domain: d.domain,
        url: d.url,
        description: d.description,
        teamId: d.teamId,
        status: d.status ?? "PENDING_SETUP",
        purchaseDate: d.purchaseDate ? new Date(d.purchaseDate) : null,
        saleDate: d.saleDate ? new Date(d.saleDate) : null,
        purchasePrice: d.purchasePrice,
        salePrice: d.salePrice,
        notes: d.notes,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "domain_taken" }, { status: 409 });
    }
    throw e;
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "website.created",
    entityType: "Website",
    entityId: website.id,
    details: { domain: website.domain },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a created website into a 500.
  return NextResponse.json({ website }, { status: 201 });
}

export const POST = withApiErrors("websites", post);
