import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

async function del(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage");
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
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "member.invite_revoked",
    entityType: "OrganizationInvite",
    entityId: id,
    details: { email: invite.email },
  });
  return NextResponse.json({ status: "ok" });
}

export const DELETE = withApiErrors("members/invite/[id]", del);
