import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withApiErrors } from "@/lib/api-error";
import { getSessionUser, requireAuthedRateLimit } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { hashToken, clientIpFromHeaders } from "@metricflock/shared";

const schema = z.object({ token: z.string().min(1) });

// Accept an invite with an EXISTING account (the sign-up path consumes
// invites automatically in the auth hook). The account moves to the
// inviting organization only when its current organization is an empty
// self-signup shell (sole member, no teams/websites/connections) —
// otherwise moving would orphan real data, so we refuse.
async function post(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // A-SEC-07: authenticated brake (default tier) on this mutation.
  const limited = await requireAuthedRateLimit(req, user);
  if ("error" in limited) return limited.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const invite = await prisma.organizationInvite.findFirst({
    where: { tokenHash: hashToken(body.data.token), acceptedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!invite) return NextResponse.json({ error: "invite_not_found_or_expired" }, { status: 404 });
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "invite_email_mismatch" }, { status: 403 });
  }
  if (user.organizationId === invite.organizationId) {
    await prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return NextResponse.json({ status: "ok", alreadyMember: true });
  }

  const [memberCount, teamCount, websiteCount, connectionCount] = await Promise.all([
    prisma.user.count({ where: { organizationId: user.organizationId } }),
    prisma.team.count({ where: { organizationId: user.organizationId } }),
    prisma.website.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.count({ where: { organizationId: user.organizationId } }),
  ]);
  if (memberCount > 1 || teamCount > 0 || websiteCount > 0 || connectionCount > 0) {
    return NextResponse.json({ error: "already_in_organization" }, { status: 409 });
  }

  const oldOrgId = user.organizationId;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { organizationId: invite.organizationId, role: invite.role },
    }),
    prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
  ]);
  // The empty shell org is now unreferenced; remove it (best-effort).
  await prisma.organization.delete({ where: { id: oldOrgId } }).catch(() => undefined);
  await writeAudit({
    organizationId: invite.organizationId,
    actorId: user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.invite_accepted",
    entityType: "OrganizationInvite",
    entityId: invite.id,
    details: { email: user.email, role: invite.role },
  }).catch(() => undefined); // A-API-04: audit failure must not turn an accepted invite into a 500.
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("invites/accept", post);
