import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { transferSchema } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { invalidateWebsiteCache } from "@/lib/cache";
// Ownership transfer (spec §11): transaction marks TRANSFER_PENDING, records the
// transfer, reassigns the team, removes old assignments, preserves history/audit.
// OAuth tokens are NEVER transferred between owners — the new team must connect
// its own Google account and map properties before the transfer completes.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.transfer");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const body = transferSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await prisma.website.findFirst({ where: { id, organizationId: auth.user.organizationId } });
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const toTeam = await prisma.team.findFirst({ where: { id: body.data.toTeamId, organizationId: auth.user.organizationId } });
  if (!toTeam) return NextResponse.json({ error: "destination_team_not_found" }, { status: 404 });
  if (website.teamId === toTeam.id) return NextResponse.json({ error: "already_in_team" }, { status: 400 });
  const result = await prisma.$transaction(async (tx) => {
    const transfer = await tx.websiteTransfer.create({ data: { websiteId: id, fromTeamId: website.teamId, toTeamId: toTeam.id, initiatedById: auth.user.id, status: "INITIATED", reason: body.data.reason } });
    await tx.website.update({ where: { id }, data: { status: "TRANSFER_PENDING", teamId: toTeam.id } });
    // Remove previous team's member assignments; history + audit logs are preserved.
    await tx.websiteAssignment.deleteMany({ where: { websiteId: id } });
    await tx.websiteTransfer.update({ where: { id: transfer.id }, data: { status: "TRANSFERRED" } });
    return transfer;
  });
  await writeAudit({ organizationId: auth.user.organizationId, actorId: auth.user.id, action: "website.transfer.initiated", entityType: "Website", entityId: id, details: { fromTeamId: website.teamId, toTeamId: toTeam.id, transferId: result.id } });
  await invalidateWebsiteCache(auth.user.organizationId, id);
  return NextResponse.json({ transfer: result, note: "Transfer recorded. New owner must connect their own Google account and map properties; then mark the transfer completed from /transfers. OAuth tokens were not transferred." });
}
