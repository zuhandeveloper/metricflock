import { NextRequest, NextResponse } from "next/server";
import { apiError, requestIdOf, withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertTeamAccess } from "@metricflock/auth";
import { teamCreateSchema, clientIpFromHeaders } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
async function patch(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("team.manage", { req });
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const team = await assertTeamAccess(auth.user, id).catch(() => null);
  if (!team) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = teamCreateSchema.partial().safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const updated = await prisma.team.update({ where: { id }, data: body.data });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "team.updated",
    entityType: "Team",
    entityId: id,
    details: { name: updated.name },
  }).catch(() => undefined); // A-API-04: audit failure must not turn an updated team into a 500.
  return NextResponse.json({ team: updated });
}

export const PATCH = withApiErrors("teams/[id]", patch);

async function del(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("team.manage", { req });
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const team = await assertTeamAccess(auth.user, id).catch(() => null);
  if (!team) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  // Website.team is Restrict (Stage 2): a team that still owns websites
  // cannot be deleted — move or delete the websites first. Team
  // members and team-level Google connections cascade with the team.
  const websiteCount = await prisma.website.count({ where: { teamId: id } });
  if (websiteCount > 0) {
    return apiError("team_has_websites", 409, { websites: websiteCount }, requestIdOf(req));
  }
  await prisma.team.delete({ where: { id } });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "team.deleted",
    entityType: "Team",
    entityId: id,
    details: { name: team.name },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a deleted team into a 500.
  return NextResponse.json({ status: "ok" });
}

export const DELETE = withApiErrors("teams/[id]", del);
