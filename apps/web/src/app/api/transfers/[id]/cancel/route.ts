import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { expireIfStale, loadTransferInOrg, OPEN_TRANSFER_STATUSES, transferStaleStateResponse } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Initiator (or SUPER_ADMIN) withdraws an open transfer -> CANCELLED.
// A-DB-01: the transition is a guarded updateMany (status in the where
// clause), so a cancel racing a complete/accept cannot resurrect — or
// overwrite — the winning state: the loser matches 0 rows and gets 409.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth();
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const found = await loadTransferInOrg(id, auth.user.organizationId);
  if (!found) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const transfer = await expireIfStale(found);
  if (auth.user.role !== "SUPER_ADMIN" && transfer.initiatedById !== auth.user.id)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (transfer.status === "EXPIRED") return NextResponse.json({ error: "transfer_expired" }, { status: 409 });
  if (!OPEN_TRANSFER_STATUSES.includes(transfer.status))
    return NextResponse.json({ error: "invalid_state", status: transfer.status }, { status: 409 });
  const result = await prisma.websiteTransfer.updateMany({
    where: { id, status: { in: OPEN_TRANSFER_STATUSES } },
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
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.transfer.cancelled",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: { transferId: id, fromTeamId: transfer.fromTeamId, toTeamId: transfer.toTeamId },
  }).catch(() => undefined); // A-DB-09: audit failure must not turn a committed transition into a 500.
  return NextResponse.json({ transfer: updated });
}

export const POST = withApiErrors("transfers/[id]/cancel", post);
