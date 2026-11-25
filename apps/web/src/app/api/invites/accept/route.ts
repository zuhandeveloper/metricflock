import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withApiErrors } from "@/lib/api-error";
import { getSessionUser, requireAuthedRateLimit } from "@metricflock/auth";
import { prisma, type Prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { createLogger, errMeta, hashToken, clientIpFromHeaders } from "@metricflock/shared";

const log = createLogger("invites/accept");

const schema = z.object({ token: z.string().min(1) });

/** A-DB-05: re-check shell-org emptiness inside the transaction with the
 *  org's rows locked (A-DB-02 pattern). The six counts before the
 *  transaction are only a fast path — between them and the commit, a
 *  second member/team/website/connection/API key/invite could be created
 *  in the shell org and the user would be moved anyway, stranding that
 *  data in an org whose only member just left. Locking the org row
 *  serializes concurrent invite-accepts for the same shell org, and the
 *  counts inside the transaction see rows committed before they run.
 *  A-SEC-20: API keys and sent invites count too — a live key is a
 *  working credential into the org (ApiKey is onDelete: Cascade, so the
 *  shell-org delete would silently destroy it) and a live sent invite is
 *  a path back into the org. */
// A-SEC-20: an API key is "live" while it can still authenticate — not
// revoked and not expired (see api-key-auth.ts, which rejects both).
// A revoked/expired key is dead, so it does not block cleanup.
function liveApiKeyWhere() {
  return { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}
// A-SEC-20: an outstanding sent invite — not yet accepted and not
// expired (the same predicate the A-DB-05 scheduler sweep uses).
// Expired/accepted invites are dead and do not block cleanup.
function outstandingInviteWhere() {
  return { acceptedAt: null, expiresAt: { gt: new Date() } };
}

async function countShellOrgLocked(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "organizationId" = ${organizationId} FOR UPDATE`;
  const [memberCount, teamCount, websiteCount, connectionCount, apiKeyCount, inviteCount] = await Promise.all([
    tx.user.count({ where: { organizationId } }),
    tx.team.count({ where: { organizationId } }),
    tx.website.count({ where: { organizationId } }),
    tx.googleConnection.count({ where: { organizationId } }),
    tx.apiKey.count({ where: { organizationId, ...liveApiKeyWhere() } }),
    tx.organizationInvite.count({ where: { organizationId, ...outstandingInviteWhere() } }),
  ]);
  return { memberCount, teamCount, websiteCount, connectionCount, apiKeyCount, inviteCount };
}

function isShellOrg(counts: {
  memberCount: number;
  teamCount: number;
  websiteCount: number;
  connectionCount: number;
  apiKeyCount: number;
  inviteCount: number;
}) {
  return (
    counts.memberCount <= 1 &&
    counts.teamCount === 0 &&
    counts.websiteCount === 0 &&
    counts.connectionCount === 0 &&
    counts.apiKeyCount === 0 &&
    counts.inviteCount === 0
  );
}

// Accept an invite with an EXISTING account (the sign-up path consumes
// invites automatically in the auth hook). The account moves to the
// inviting organization only when its current organization is an empty
// self-signup shell (sole member, no teams/websites/connections, no live
// API keys, no outstanding sent invites — A-SEC-20) — otherwise moving
// would orphan real data, so we refuse.
async function post(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // A-SEC-07: authenticated brake (default tier) on this mutation.
  const limited = await requireAuthedRateLimit(req, user);
  if ("error" in limited) return limited.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const invite = await prisma.organizationInvite.findFirst({
    where: { tokenHash: hashToken(body.data.token), acceptedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!invite) return NextResponse.json({ error: "invite_not_found_or_expired" }, { status: 404 });
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "invite_email_mismatch" }, { status: 403 });
  }
  if (user.organizationId === invite.organizationId) {
    await prisma.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return NextResponse.json({ status: "ok", alreadyMember: true });
  }

  // Fast path only — the emptiness check is re-run inside the
  // transaction below (see countShellOrgLocked).
  const [memberCount, teamCount, websiteCount, connectionCount, apiKeyCount, inviteCount] = await Promise.all([
    prisma.user.count({ where: { organizationId: user.organizationId } }),
    prisma.team.count({ where: { organizationId: user.organizationId } }),
    prisma.website.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.count({ where: { organizationId: user.organizationId } }),
    prisma.apiKey.count({ where: { organizationId: user.organizationId, ...liveApiKeyWhere() } }),
    prisma.organizationInvite.count({ where: { organizationId: user.organizationId, ...outstandingInviteWhere() } }),
  ]);
  if (!isShellOrg({ memberCount, teamCount, websiteCount, connectionCount, apiKeyCount, inviteCount })) {
    return NextResponse.json({ error: "already_in_organization" }, { status: 409 });
  }

  const oldOrgId = user.organizationId;
  const moved = await prisma.$transaction(async (tx) => {
    if (!isShellOrg(await countShellOrgLocked(tx, oldOrgId))) return false;
    await tx.user.update({
      where: { id: user.id },
      data: { organizationId: invite.organizationId, role: invite.role },
    });
    await tx.organizationInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return true;
  });
  if (!moved) return NextResponse.json({ error: "already_in_organization" }, { status: 409 });
  // A-DB-05: the shell-org delete stays OUTSIDE the transaction
  // deliberately. AuditLog.organization is onDelete: Restrict, so a shell
  // org with any audit history cannot be deleted at all — deleting inside
  // the transaction would roll back legitimate accepts. Deleting the
  // audit rows first inside the transaction is NOT an option either:
  // A-SEC-19 requires a completed export before an org's audit trail is
  // destroyed, so invite-accept must never silently erase it. And the
  // counted relations are onDelete: Cascade, so an in-transaction delete
  // would silently destroy a team/website created concurrently instead
  // of failing. The guarded deleteMany below re-verifies emptiness in
  // the SAME statement, so data created between the move and the delete
  // is never destroyed: the delete then affects 0 rows, the org survives
  // with its data, and the scheduler sweep (A-DB-05) picks up the
  // genuinely empty leftovers. A failure is logged, never swallowed.
  // A-SEC-20: the guard also requires no live API keys and no
  // outstanding sent invites, matching the shell check above.
  const deleted = await prisma.organization
    .deleteMany({
      where: {
        id: oldOrgId,
        users: { none: {} },
        teams: { none: {} },
        websites: { none: {} },
        connections: { none: {} },
        apiKeys: { none: liveApiKeyWhere() },
        invites: { none: outstandingInviteWhere() },
      },
    })
    .catch((err: unknown) => {
      log.error("shell-org delete failed after invite accept", { organizationId: oldOrgId, ...errMeta(err) });
      return null;
    });
  if (deleted && deleted.count === 0) {
    log.warn("shell org not deleted after invite accept: no longer empty", { organizationId: oldOrgId });
  }
  await writeAudit({
    organizationId: invite.organizationId,
    actorId: user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "member.invite_accepted",
    entityType: "OrganizationInvite",
    entityId: invite.id,
    details: { email: user.email, role: invite.role },
  }).catch(() => undefined); // A-API-04: audit failure must not turn an accepted invite into a 500.
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("invites/accept", post);
