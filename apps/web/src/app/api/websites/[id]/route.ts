import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertWebsiteAccess, assertWebsiteManageAccess, assertTeamManageAccess } from "@metricflock/auth";
import { websiteCreateSchema, invalidateWebsiteCache } from "@metricflock/shared";
import { invalidateWebsiteSnapshots } from "@metricflock/db/snapshots";
import { writeAudit } from "@metricflock/db/audit";
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.view");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const website = await assertWebsiteAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const full = await prisma.website.findUnique({
    where: { id },
    include: {
      team: true,
      assignments: { include: { user: { select: { id: true, email: true, name: true } } } },
      integrations: true,
      transfers: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  return NextResponse.json({ website: full });
}
async function patch(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  // Manage-level access (SUPER_ADMIN or isAdmin of the website's team).
  // View-level access via assignment must never allow edits (F-1.1).
  const website = await assertWebsiteManageAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = websiteCreateSchema.partial().safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const d = body.data;
  // Moving a website requires manage access to the DESTINATION team as
  // well (F-1.2) — same-org membership alone is not enough. `teamId: null`
  // (unassign) is allowed; the current-team manage check above covers it.
  if (d.teamId) {
    const team = await assertTeamManageAccess(auth.user, d.teamId).catch(() => null);
    if (!team) return NextResponse.json({ error: "team_not_found" }, { status: 404 });
  }
  let updated;
  try {
    // Reassignment runs in a transaction that re-verifies the destination
    // team inside the same unit of work, so a failed move can never leave
    // the website half-updated.
    updated = await prisma.$transaction(async (tx) => {
      if (d.teamId) {
        const team = await tx.team.findFirst({
          where: { id: d.teamId, organizationId: auth.user.organizationId },
          select: { id: true },
        });
        if (!team) throw new Error("TEAM_NOT_FOUND");
      }
      return tx.website.update({
        where: { id },
        data: {
          name: d.name,
          domain: d.domain,
          url: d.url,
          description: d.description,
          teamId: d.teamId,
          status: d.status,
          purchaseDate: d.purchaseDate ? new Date(d.purchaseDate) : undefined,
          saleDate: d.saleDate ? new Date(d.saleDate) : undefined,
          purchasePrice: d.purchasePrice,
          salePrice: d.salePrice,
          notes: d.notes,
        },
      });
    });
  } catch (e) {
    if ((e as Error).message === "TEAM_NOT_FOUND") {
      return NextResponse.json({ error: "team_not_found" }, { status: 404 });
    }
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "domain_taken" }, { status: 409 });
    }
    throw e;
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.updated",
    entityType: "Website",
    entityId: id,
    details: { domain: updated.domain },
  });
  return NextResponse.json({ website: updated });
}

export const PATCH = withApiErrors("websites/[id]", patch);

async function del(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  // Manage-level access only — an assigned viewer must never delete (F-1.1).
  const website = await assertWebsiteManageAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  // Integrations, assignments, transfers, sync jobs and website-level
  // Google connections cascade with the website (schema onDelete).
  await prisma.website.delete({ where: { id } });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.deleted",
    entityType: "Website",
    entityId: id,
    details: { domain: website.domain },
  });
  await invalidateWebsiteCache(auth.user.organizationId, id);
  await invalidateWebsiteSnapshots(id);
  return NextResponse.json({ status: "ok" });
}

export const DELETE = withApiErrors("websites/[id]", del);
