import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { createLogger } from "@metricflock/shared";
import { revokeConnection } from "@metricflock/google/tokens";
import { z } from "zod";

const schema = z.object({ confirmSlug: z.string().min(1) });

// Organization deletion (Phase 4, F-4.3 — docs/security/data-lifecycle.md).
// SUPER_ADMIN only (organization.manage), slug-typed confirmation.
// Google refresh tokens are revoked best-effort first so deleted data
// does not leave live grants behind. Audit rows are deleted with the
// organization (their FK is Restrict by design — export first if an
// archive is needed), so the deletion itself is recorded in server
// logs, not the audit table.
async function del(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage");
  if ("error" in auth) return auth.error;
  // A-SEC-02: deleting the whole organization is destructive — require
  // a fresh session (re-authentication), not a 30-day-old cookie.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const org = await prisma.organization.findUnique({
    where: { id: auth.user.organizationId },
    select: { id: true, slug: true, name: true },
  });
  if (!org) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (body.data.confirmSlug !== org.slug) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const log = createLogger("organization-delete");
  const connections = await prisma.googleConnection.findMany({
    where: { organizationId: org.id },
    select: { id: true },
  });
  for (const c of connections) {
    await revokeConnection(c.id).catch(() => undefined); // best-effort
  }
  log.warn("organization deletion starting", {
    organizationId: org.id,
    slug: org.slug,
    actorId: auth.user.id,
    connectionsRevoked: connections.length,
  });

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { organizationId: org.id } });
    await tx.organization.delete({ where: { id: org.id } });
  });
  log.warn("organization deleted", { organizationId: org.id, slug: org.slug, actorId: auth.user.id });
  return NextResponse.json({ deleted: true });
}

export const DELETE = withApiErrors("organization", del);
