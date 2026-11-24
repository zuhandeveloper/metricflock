import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { canActForDestination, expireIfStale, loadTransferInOrg, transferStaleStateResponse } from "@/lib/transfers";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateWebsiteCache, clientIpFromHeaders } from "@metricflock/shared";
import { invalidateWebsiteSnapshots } from "@metricflock/db/snapshots";

// Completes an accepted transfer. This is the ONLY step that moves
// anything: teamId switches to the destination team, the old team's
// assignments are removed, and old property mappings are cleared (they
// point at the old team's Google account — the new team re-maps with its
// own). Requires the destination team to have an ACTIVE Google
// connection first, so the site is never handed over blind.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(undefined, { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: completing a transfer moves a website between teams —
  // require a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
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
  // A-DB-01: the status guard runs FIRST inside the transaction as a
  // conditional updateMany. Under Read Committed the guarded write takes
  // a row lock, so a concurrent complete/cancel serializes behind it
  // and then matches 0 rows: the transaction returns null before any
  // side effect (website flip, assignment/integration deletes) runs,
  // so a cancelled transfer can never be resurrected and a completed
  // one is never completed twice.
  const updated = await prisma.$transaction(async (tx) => {
    const guard = await tx.websiteTransfer.updateMany({
      where: { id, status: "PENDING_CONNECTION" },
      data: { status: "COMPLETED", completedAt: new Date(), connectionHealthChecked: true },
    });
    if (guard.count === 0) return null;
    await tx.website.update({
      where: { id: transfer.websiteId },
      data: { teamId: transfer.toTeamId, status: "ACTIVE" },
    });
    await tx.websiteAssignment.deleteMany({ where: { websiteId: transfer.websiteId } });
    await tx.websiteIntegration.deleteMany({ where: { websiteId: transfer.websiteId } });
    return tx.websiteTransfer.findUnique({ where: { id } });
  });
  if (!updated) {
    const current = await prisma.websiteTransfer.findUnique({ where: { id }, select: { status: true } });
    return transferStaleStateResponse(current?.status ?? transfer.status);
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "website.transfer.completed",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: {
      transferId: id,
      fromTeamId: transfer.fromTeamId,
      toTeamId: transfer.toTeamId,
      destinationConnectionId: destinationConnection.id,
    },
  }).catch(() => undefined); // A-DB-09: audit failure must not turn a committed completion into a 500.
  await invalidateWebsiteCache(auth.user.organizationId, transfer.websiteId);
  await invalidateWebsiteSnapshots(transfer.websiteId);
  return NextResponse.json({
    transfer: updated,
    note: "Transfer completed. The destination team should now discover and map its properties for this website.",
  });
}

export const POST = withApiErrors("transfers/[id]/complete", post);
