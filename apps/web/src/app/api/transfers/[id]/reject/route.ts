import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { canActForDestination, expireIfStale, loadTransferInOrg } from "@/lib/transfers";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Destination declines the transfer: PENDING_ACCEPTANCE -> CANCELLED.
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
  if (transfer.status !== "PENDING_ACCEPTANCE")
    return NextResponse.json({ error: "invalid_state", status: transfer.status }, { status: 409 });
  const updated = await prisma.websiteTransfer.update({ where: { id }, data: { status: "CANCELLED" } });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "website.transfer.rejected",
    entityType: "Website",
    entityId: transfer.websiteId,
    details: { transferId: id, toTeamId: transfer.toTeamId },
  });
  return NextResponse.json({ transfer: updated });
}

export const POST = withApiErrors("transfers/[id]/reject", post);
