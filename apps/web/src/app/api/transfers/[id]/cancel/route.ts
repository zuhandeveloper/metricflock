import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { expireIfStale, loadTransferInOrg, OPEN_TRANSFER_STATUSES } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Initiator (or SUPER_ADMIN) withdraws an open transfer -> CANCELLED.
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
  const updated = await prisma.websiteTransfer.update({ where: { id }, data: { status: "CANCELLED" } });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.transfer.cancelled",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: { transferId: id, fromTeamId: transfer.fromTeamId, toTeamId: transfer.toTeamId },
  });
  return NextResponse.json({ transfer: updated });
}

export const POST = withApiErrors("transfers/[id]/cancel", post);
