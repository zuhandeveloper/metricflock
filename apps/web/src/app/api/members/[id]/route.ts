import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma, type Prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { memberRoleSchema, clientIpFromHeaders } from "@metricflock/shared";

/** A-DB-02: lock the org's SUPER_ADMIN rows (SELECT … FOR UPDATE) and
 *  count them inside `tx`. A plain $transaction at Read Committed does
 *  NOT fix the last-admin race on its own — without the lock, two
 *  concurrent demote/delete requests both count 2 and both proceed,
 *  leaving zero SUPER_ADMINs. The lock serializes them: the second
 *  waits, then counts the committed result (1) and is refused. */
async function countSuperAdminsLocked(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "organizationId" = ${organizationId} AND "role" = 'SUPER_ADMIN' FOR UPDATE`;
  return tx.user.count({ where: { organizationId, role: "SUPER_ADMIN" } });
}

async function patch(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage", { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: role change is privilege-minting — require a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const { id } = await ctx.params;
  const body = memberRoleSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });

  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.user.organizationId },
    select: { id: true, role: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot_change_own_role" }, { status: 400 });

  // Only a SUPER_ADMIN may grant or revoke SUPER_ADMIN.
  const touchesSuperAdmin = body.data.role === "SUPER_ADMIN" || target.role === "SUPER_ADMIN";
  if (touchesSuperAdmin && auth.user.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Never demote the last SUPER_ADMIN (same guard as the team members
  // route's last-admin rule). A-DB-02: the count + demote run inside one
  // transaction with the admin rows locked (see countSuperAdminsLocked).
  let updated;
  if (target.role === "SUPER_ADMIN" && body.data.role !== "SUPER_ADMIN") {
    updated = await prisma.$transaction(async (tx) => {
      const admins = await countSuperAdminsLocked(tx, auth.user.organizationId);
      if (admins <= 1) return null;
      return tx.user.update({
        where: { id },
        data: { role: body.data.role },
        select: { id: true, email: true, role: true },
      });
    });
    if (!updated) return NextResponse.json({ error: "last_super_admin" }, { status: 409 });
  } else {
    updated = await prisma.user.update({
      where: { id },
      data: { role: body.data.role },
      select: { id: true, email: true, role: true },
    });
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.role_changed",
    entityType: "User",
    entityId: id,
    details: { email: target.email, from: target.role, to: body.data.role },
  }).catch(() => undefined); // A-DB-09: audit failure must not turn a committed role change into a 500.
  return NextResponse.json({ member: updated });
}

export const PATCH = withApiErrors("members/[id]", patch);

// Member deletion (Phase 4, F-4.3 — docs/security/data-lifecycle.md).
// Sessions/accounts/memberships/assignments cascade; audit rows survive
// with the actor nulled. Deletion is blocked (409) while the user is
// recorded as creator of Google connections or initiator of transfers
// (Restrict FKs) so ownership history is never silently orphaned.
async function del(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage", { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: member deletion is destructive — require a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const { id } = await ctx.params;

  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.user.organizationId },
    select: { id: true, role: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  if (target.role === "SUPER_ADMIN" && auth.user.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [connections, transfers] = await Promise.all([
    prisma.googleConnection.count({ where: { createdById: id } }),
    prisma.websiteTransfer.count({ where: { initiatedById: id } }),
  ]);
  if (connections > 0 || transfers > 0) {
    return NextResponse.json(
      { error: "member_has_dependencies", details: { connections, transfers } },
      { status: 409 },
    );
  }

  // A-DB-02: the last-admin count + delete run inside one transaction
  // with the admin rows locked (see countSuperAdminsLocked), so two
  // concurrent deletes of the last two SUPER_ADMINs cannot both pass
  // the count and leave the org admin-less.
  const deleted = await prisma.$transaction(async (tx) => {
    if (target.role === "SUPER_ADMIN") {
      const admins = await countSuperAdminsLocked(tx, auth.user.organizationId);
      if (admins <= 1) return false;
    }
    await tx.user.delete({ where: { id } });
    return true;
  });
  if (!deleted) return NextResponse.json({ error: "last_super_admin" }, { status: 409 });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.deleted",
    entityType: "User",
    entityId: id,
    details: { email: target.email, role: target.role },
  }).catch(() => undefined); // A-DB-09: a committed delete must stay a 200 even if the audit write fails (dynamic verification: the audit failed with P2003 when the actor was deleted concurrently, masking a successful delete as a 400).
  return NextResponse.json({ deleted: true });
}

export const DELETE = withApiErrors("members/[id]", del);
