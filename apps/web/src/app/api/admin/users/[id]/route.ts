import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { isPlatformAdmin, requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma, type Prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { memberRoleSchema, clientIpFromHeaders } from "@metricflock/shared";

/** A-DB-02: lock the org's SUPER_ADMIN rows (SELECT … FOR UPDATE) and
 *  count them inside `tx` — same pattern as the members role-change
 *  route, replicated here for the TARGET's organization (the platform
 *  admin acts across organizations, so the lock must be on the target's
 *  org, not the actor's). */
async function countSuperAdminsLocked(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "organizationId" = ${organizationId} AND "role" = 'SUPER_ADMIN' FOR UPDATE`;
  return tx.user.count({ where: { organizationId, role: "SUPER_ADMIN" } });
}

// Platform-admin role change: the first registered user on the platform
// (see packages/auth/src/platform.ts) may change any user's role within
// that user's own organization. No org permission gates this — the
// platform check below is the authority — but the last-SUPER_ADMIN guard
// still protects the target's organization from being left admin-less.
async function patch(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth(undefined, { req });
  if ("error" in auth) return auth.error;
  if (!(await isPlatformAdmin(auth.user.id))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // A-SEC-02: role change is privilege-minting — require a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const { id } = await ctx.params;
  const body = memberRoleSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });

  // Platform-wide lookup: deliberately NOT scoped to the actor's org.
  const target = await prisma.user.findFirst({
    where: { id },
    select: { id: true, role: true, email: true, organizationId: true },
  });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot_change_own_role" }, { status: 400 });

  // A-DB-09: the audit row is written inside the demote transaction, so
  // it commits or rolls back with the demote. An audit failure there
  // fails the demote (500, nothing committed) instead of reporting
  // success for a demote whose record was lost — the plain role-change
  // path below has no transaction, so it stays best-effort.
  const auditOpts = {
    organizationId: target.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.role_changed",
    entityType: "User",
    entityId: id,
    details: { email: target.email, from: target.role, to: body.data.role },
  };
  let updated;
  if (target.role === "SUPER_ADMIN" && body.data.role !== "SUPER_ADMIN") {
    updated = await prisma.$transaction(async (tx) => {
      const admins = await countSuperAdminsLocked(tx, target.organizationId);
      if (admins <= 1) return null;
      const u = await tx.user.update({
        where: { id },
        data: { role: body.data.role },
        select: { id: true, email: true, role: true },
      });
      await writeAudit(auditOpts, tx);
      return u;
    });
    if (!updated) return NextResponse.json({ error: "last_super_admin" }, { status: 409 });
  } else {
    updated = await prisma.user.update({
      where: { id },
      data: { role: body.data.role },
      select: { id: true, email: true, role: true },
    });
    await writeAudit(auditOpts).catch(() => undefined); // A-DB-09: audit failure must not turn a committed role change into a 500.
  }
  return NextResponse.json({ member: updated });
}

export const PATCH = withApiErrors("admin/users/[id]", patch);
