import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";

async function del(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage", { req });
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const invite = await prisma.organizationInvite.findFirst({
    where: { id, organizationId: auth.user.organizationId },
  });
  if (!invite) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await prisma.organizationInvite.delete({ where: { id } });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.invite_revoked",
    entityType: "OrganizationInvite",
    entityId: id,
    details: { email: invite.email },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a revoked invite into a 500.
  return NextResponse.json({ status: "ok" });
}

export const DELETE = withApiErrors("members/invite/[id]", del);
