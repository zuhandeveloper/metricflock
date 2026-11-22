import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertTeamAccess } from "@metricflock/auth";
import { writeAudit } from "@metricflock/db/audit";
import { z } from "zod";
const schema = z.object({
  userId: z.string().min(1),
  isAdmin: z.boolean().optional(),
  action: z.enum(["add", "remove"]).default("add"),
});
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const team = await assertTeamAccess(auth.user, id).catch(() => null);
  if (!team) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const target = await prisma.user.findFirst({
    where: { id: body.data.userId, organizationId: auth.user.organizationId },
  });
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (body.data.action === "add") {
    // Only change isAdmin when the caller explicitly provides it —
    // re-adding an existing admin must not silently demote them.
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: id, userId: target.id },
      select: { isAdmin: true },
    });
    const demoting = existing?.isAdmin === true && body.data.isAdmin === false;
    if (demoting) {
      const admins = await prisma.teamMember.count({ where: { teamId: id, isAdmin: true } });
      if (admins <= 1) return NextResponse.json({ error: "last_admin" }, { status: 409 });
    }
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: id, userId: target.id } },
      update: body.data.isAdmin !== undefined ? { isAdmin: body.data.isAdmin } : {},
      create: {
        teamId: id,
        userId: target.id,
        organizationId: auth.user.organizationId,
        isAdmin: body.data.isAdmin ?? false,
      },
    });
  } else {
    // Never remove the team's last admin (would lock the team).
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: id, userId: target.id },
      select: { isAdmin: true },
    });
    if (existing?.isAdmin) {
      const admins = await prisma.teamMember.count({ where: { teamId: id, isAdmin: true } });
      if (admins <= 1) return NextResponse.json({ error: "last_admin" }, { status: 409 });
    }
    await prisma.teamMember.deleteMany({ where: { teamId: id, userId: target.id } });
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: `team.member.${body.data.action}`,
    entityType: "Team",
    entityId: id,
    // DB-10: role (isAdmin) changes are part of the audit record.
    details: { userId: target.id, isAdmin: body.data.isAdmin ?? undefined },
  });
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("teams/[id]/members", post);
