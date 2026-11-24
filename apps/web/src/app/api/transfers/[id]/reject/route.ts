import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { canActForDestination, expireIfStale, loadTransferInOrg, transferStaleStateResponse } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";

// Destination declines the transfer: PENDING_ACCEPTANCE -> CANCELLED.
// A-DB-01: the transition is a guarded updateMany (status in the where
// clause), so a reject racing an accept cannot both succeed: the loser
// matches 0 rows and gets 409.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(undefined, { req });
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const found = await loadTransferInOrg(id, auth.user.organizationId);
  if (!found) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const transfer = await expireIfStale(found);
  if (!(await canActForDestination(auth.user, transfer.toTeamId)))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (transfer.status === "EXPIRED") return NextResponse.json({ error: "transfer_expired" }, { status: 409 });
  if (transfer.status !== "PENDING_ACCEPTANCE")
    return NextResponse.json({ error: "invalid_state", status: transfer.status }, { status: 409 });
  const result = await prisma.websiteTransfer.updateMany({
    where: { id, status: "PENDING_ACCEPTANCE" },
    data: { status: "CANCELLED" },
  });
  if (result.count === 0) {
    const current = await prisma.websiteTransfer.findUnique({ where: { id }, select: { status: true } });
    return transferStaleStateResponse(current?.status ?? transfer.status);
  }
  const updated = await prisma.websiteTransfer.findUnique({ where: { id } });
  if (!updated) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "website.transfer.rejected",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: { transferId: id, toTeamId: transfer.toTeamId },
  }).catch(() => undefined); // A-DB-09: audit failure must not turn a committed transition into a 500.
  return NextResponse.json({ transfer: updated });
}

export const POST = withApiErrors("transfers/[id]/reject", post);
