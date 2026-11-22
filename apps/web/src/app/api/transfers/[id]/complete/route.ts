import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { canActForDestination, expireIfStale, loadTransferInOrg } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateWebsiteCache } from "@metricflock/shared";
import { invalidateWebsiteSnapshots } from "@metricflock/db/snapshots";

// Completes an accepted transfer. This is the ONLY step that moves
// anything: teamId switches to the destination team, the old team's
// assignments are removed, and old property mappings are cleared (they
// point at the old team's Google account — the new team re-maps with its
// own). Requires the destination team to have an ACTIVE Google
// connection first, so the site is never handed over blind.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const found = await loadTransferInOrg(id, auth.user.organizationId);
  if (!found) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const transfer = await expireIfStale(found);
  if (!(await canActForDestination(auth.user, transfer.toTeamId)))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (transfer.status === "EXPIRED") return NextResponse.json({ error: "transfer_expired" }, { status: 409 });
  if (transfer.status !== "PENDING_CONNECTION")
    return NextResponse.json({ error: "invalid_state", status: transfer.status }, { status: 409 });
  const destinationConnection = await prisma.googleConnection.findFirst({
    where: { organizationId: auth.user.organizationId, teamId: transfer.toTeamId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!destinationConnection)
    return NextResponse.json(
      {
        error: "destination_not_connected",
        note: "The destination team must connect its own Google account (Integrations) before the transfer can complete.",
      },
      { status: 409 },
    );
  const updated = await prisma.$transaction(async (tx) => {
    await tx.website.update({
      where: { id: transfer.websiteId },
      data: { teamId: transfer.toTeamId, status: "ACTIVE" },
    });
    await tx.websiteAssignment.deleteMany({ where: { websiteId: transfer.websiteId } });
    await tx.websiteIntegration.deleteMany({ where: { websiteId: transfer.websiteId } });
    return tx.websiteTransfer.update({
      where: { id },
      data: { status: "COMPLETED", completedAt: new Date(), connectionHealthChecked: true },
    });
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.transfer.completed",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: {
      transferId: id,
      fromTeamId: transfer.fromTeamId,
      toTeamId: transfer.toTeamId,
      destinationConnectionId: destinationConnection.id,
    },
  });
  await invalidateWebsiteCache(auth.user.organizationId, transfer.websiteId);
  await invalidateWebsiteSnapshots(transfer.websiteId);
  return NextResponse.json({
    transfer: updated,
    note: "Transfer completed. The destination team should now discover and map its properties for this website.",
  });
}

export const POST = withApiErrors("transfers/[id]/complete", post);
