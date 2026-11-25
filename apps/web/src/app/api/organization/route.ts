import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { createLogger } from "@metricflock/shared";
import { revokeConnectionToken } from "@metricflock/google/tokens";
import { z } from "zod";

const schema = z.object({ confirmSlug: z.string().min(1) });

// Organization deletion (Phase 4, F-4.3 — docs/security/data-lifecycle.md).
// SUPER_ADMIN only (organization.manage), slug-typed confirmation.
// A-DB-06: Google refresh tokens are revoked AFTER the delete
// transaction commits — revoking first destroyed every token even when
// the delete then failed. The connection rows cascade away with the
// org, so the revoke material (encrypted refresh token + AAD parts) is
// captured before the transaction and revoked from that material
// afterwards; a crash between commit and revoke leaves live grants
// (the lesser evil, same best-effort posture as elsewhere). Audit rows
// are deleted with the organization (their FK is Restrict by design),
// so deletion is refused until a completed export exists (the
// `organization.exported` audit row left by GET
// /api/organization/export), and the deletion itself is recorded in
// server logs at error level (actor + slug + member/website/team
// counts), not the audit table.
async function del(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
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

  // A-SEC-19: the audit trail is deleted with the org, so require a
  // completed export first. The export route leaves an
  // `organization.exported` audit row; without it there is no archive
  // and no record the export ever happened.
  const exported = await prisma.auditLog.findFirst({
    where: { organizationId: org.id, action: "organization.exported" },
    select: { id: true },
  });
  if (!exported) {
    return NextResponse.json({ error: "export_required" }, { status: 409 });
  }

  const log = createLogger("organization-delete");
  // A-DB-06: capture the revoke material BEFORE the delete transaction
  // (the rows cascade away with the org); revoke only after it commits.
  const connections = await prisma.googleConnection.findMany({
    where: { organizationId: org.id },
    select: {
      id: true,
      encryptedRefreshToken: true,
      organizationId: true,
      ownerType: true,
      ownerId: true,
      googleAccountEmail: true,
    },
  });
  // A-SEC-19: counts for the error-level deletion log — the audit rows
  // are gone after the transaction, so this log is the durable record.
  const [memberCount, websiteCount, teamCount] = await Promise.all([
    prisma.user.count({ where: { organizationId: org.id } }),
    prisma.website.count({ where: { organizationId: org.id } }),
    prisma.team.count({ where: { organizationId: org.id } }),
  ]);
  log.warn("organization deletion starting", {
    organizationId: org.id,
    slug: org.slug,
    actorId: auth.user.id,
    connectionsFound: connections.length,
  });

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { organizationId: org.id } });
    await tx.organization.delete({ where: { id: org.id } });
  });

  // A-DB-06: revoke after commit. Best-effort per connection; a failure
  // here must not turn a completed delete into a 500.
  let connectionsRevoked = 0;
  let connectionsRevokeFailed = 0;
  for (const c of connections) {
    if (await revokeConnectionToken(c)) connectionsRevoked++;
    else connectionsRevokeFailed++;
  }
  log.error("organization deleted", {
    organizationId: org.id,
    slug: org.slug,
    actorId: auth.user.id,
    members: memberCount,
    websites: websiteCount,
    teams: teamCount,
    connectionsRevoked,
    connectionsRevokeFailed,
  });
  return NextResponse.json({ deleted: true });
}

export const DELETE = withApiErrors("organization", del);
