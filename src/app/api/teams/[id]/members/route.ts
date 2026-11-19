import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@metricflock/db";
import { assertTeamAccess } from "@/lib/tenant";
import { writeAudit } from "@/lib/audit";
import { z } from "zod";
const schema = z.object({ userId: z.string().min(1), isAdmin: z.boolean().optional(), action: z.enum(["add", "remove"]).default("add") });
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const team = await assertTeamAccess(auth.user, id).catch(() => null);
  if (!team) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const target = await prisma.user.findFirst({ where: { id: body.data.userId, organizationId: auth.user.organizationId } });
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (body.data.action === "add") {
    await prisma.teamMember.upsert({ where: { teamId_userId: { teamId: id, userId: target.id } }, update: { isAdmin: body.data.isAdmin ?? false }, create: { teamId: id, userId: target.id, isAdmin: body.data.isAdmin ?? false } });
  } else {
    await prisma.teamMember.deleteMany({ where: { teamId: id, userId: target.id } });
  }
  await writeAudit({ organizationId: auth.user.organizationId, actorId: auth.user.id, action: `team.member.${body.data.action}`, entityType: "Team", entityId: id, details: { userId: target.id } });
  return NextResponse.json({ status: "ok" });
}
