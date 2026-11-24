import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Revoke an API key (Phase 7.5). Sets revokedAt; the row stays for
// audit history. Revoking an already-revoked key is a no-op success.
async function del(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("organization.manage", { req: _req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: revoking a persistent org credential requires a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const { id } = await ctx.params;
  const key = await prisma.apiKey.findFirst({
    where: { id, organizationId: auth.user.organizationId },
    select: { id: true, revokedAt: true },
  });
  if (!key) return apiError("api_key_not_found", 404);
  if (!key.revokedAt) {
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit({
      organizationId: auth.user.organizationId,
      actorId: auth.user.id,
      action: "api_key.revoked",
      entityType: "ApiKey",
      entityId: id,
    });
  }
  return NextResponse.json({ ok: true });
}

export const DELETE = withApiErrors("api-keys/[id]", del);
