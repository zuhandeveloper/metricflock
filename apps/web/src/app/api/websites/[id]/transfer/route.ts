import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { OPEN_TRANSFER_STATUSES, TRANSFER_TTL_MS } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { transferSchema, clientIpFromHeaders } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
// Two-sided ownership transfer (Stage 7, API-4/DB-4). Initiating only
// RECORDS the intent: the destination team's admin must accept, then
// connect their own Google account, then complete — teamId, assignments
// and integrations move at completion, never before. OAuth tokens are
// NEVER transferred between owners.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.transfer", { req });
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const body = transferSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await prisma.website.findFirst({ where: { id, organizationId: auth.user.organizationId } });
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const toTeam = await prisma.team.findFirst({
    where: { id: body.data.toTeamId, organizationId: auth.user.organizationId },
  });
  if (!toTeam) return NextResponse.json({ error: "destination_team_not_found" }, { status: 404 });
  if (website.teamId === toTeam.id) return NextResponse.json({ error: "already_in_team" }, { status: 400 });
  const open = await prisma.websiteTransfer.findFirst({
    where: { websiteId: id, status: { in: OPEN_TRANSFER_STATUSES } },
  });
  if (open) return NextResponse.json({ error: "transfer_in_progress", transferId: open.id }, { status: 409 });
  // F-4.2: two concurrent initiates can both pass the check above; the
  // one-open-transfer partial unique index then rejects the second
  // insert (P2002). Map that race to the same stable 409 contract
  // instead of the generic conflict code.
  let transfer;
  try {
    transfer = await prisma.websiteTransfer.create({
      data: {
        websiteId: id,
        fromTeamId: website.teamId,
        toTeamId: toTeam.id,
        initiatedById: auth.user.id,
        status: "PENDING_ACCEPTANCE",
        reason: body.data.reason,
        expiresAt: new Date(Date.now() + TRANSFER_TTL_MS),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const raced = await prisma.websiteTransfer.findFirst({
        where: { websiteId: id, status: { in: OPEN_TRANSFER_STATUSES } },
        select: { id: true },
      });
      return NextResponse.json(
        { error: "transfer_in_progress", ...(raced ? { transferId: raced.id } : {}) },
        { status: 409 },
      );
    }
    throw e;
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "website.transfer.initiated",
    entityType: "Website",
    entityId: id,
    details: { fromTeamId: website.teamId, toTeamId: toTeam.id, transferId: transfer.id },
  });
  return NextResponse.json({
    transfer,
    note: "Transfer initiated. The destination team's admin must accept it from /transfers; the website stays with the current team until the transfer completes.",
  });
}

export const POST = withApiErrors("websites/[id]/transfer", post);
