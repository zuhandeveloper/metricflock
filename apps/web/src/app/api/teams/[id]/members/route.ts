import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma, type Prisma } from "@metricflock/db";
import { assertTeamAccess } from "@metricflock/auth";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";
import { z } from "zod";
const schema = z.object({
  userId: z.string().min(1),
  isAdmin: z.boolean().optional(),
  action: z.enum(["add", "remove"]).default("add"),
});

/** A-SEC-18: lock the team's admin rows (SELECT … FOR UPDATE) and
 *  count them inside `tx`. A plain $transaction at Read Committed does
 *  NOT fix the last-admin race on its own — without the lock, two
 *  concurrent demote/remove requests both count 2 and both proceed,
 *  leaving zero team admins. The lock serializes them: the second
 *  waits, then counts the committed result (1) and is refused.
 *  (Same pattern as countSuperAdminsLocked in members/[id]/route.ts,
 *  which covers the org half of this finding.) */
async function countTeamAdminsLocked(tx: Prisma.TransactionClient, teamId: string) {
  await tx.$queryRaw`SELECT "id" FROM "TeamMember" WHERE "teamId" = ${teamId} AND "isAdmin" = true FOR UPDATE`;
  return tx.teamMember.count({ where: { teamId, isAdmin: true } });
}

async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage", { req });
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
      // A-SEC-18: the last-admin count + demote run inside one
      // transaction with the admin rows locked (see
      // countTeamAdminsLocked), so two concurrent demotes of the last
      // two admins cannot both pass the count and leave the team
      // admin-less.
      const ok = await prisma.$transaction(async (tx) => {
        const admins = await countTeamAdminsLocked(tx, id);
        if (admins <= 1) return false;
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId: id, userId: target.id } },
          update: { isAdmin: false },
          create: {
            teamId: id,
            userId: target.id,
            organizationId: auth.user.organizationId,
            isAdmin: false,
          },
        });
        return true;
      });
      if (!ok) return NextResponse.json({ error: "last_admin" }, { status: 409 });
    } else {
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
    }
  } else {
    // Never remove the team's last admin (would lock the team).
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: id, userId: target.id },
      select: { isAdmin: true },
    });
    if (existing?.isAdmin) {
      // A-SEC-18: same locked-transaction guard as the demote path.
      const ok = await prisma.$transaction(async (tx) => {
        const admins = await countTeamAdminsLocked(tx, id);
        if (admins <= 1) return false;
        await tx.teamMember.deleteMany({ where: { teamId: id, userId: target.id } });
        return true;
      });
      if (!ok) return NextResponse.json({ error: "last_admin" }, { status: 409 });
    } else {
      await prisma.teamMember.deleteMany({ where: { teamId: id, userId: target.id } });
    }
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: `team.member.${body.data.action}`,
    entityType: "Team",
    entityId: id,
    // DB-10: role (isAdmin) changes are part of the audit record.
    details: { userId: target.id, isAdmin: body.data.isAdmin ?? undefined },
  }).catch(() => undefined); // A-API-04: audit failure must not fail the mutation.
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("teams/[id]/members", post);
