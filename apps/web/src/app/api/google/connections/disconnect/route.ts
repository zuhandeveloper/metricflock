import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession, assertConnectionVisible } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { revokeConnection } from "@metricflock/google/tokens";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateOrgCache, clientIpFromHeaders } from "@metricflock/shared";
import { invalidateOrgSnapshots } from "@metricflock/db/snapshots";
import { z } from "zod";
const schema = z.object({ connectionId: z.string().min(1) });
async function post(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage", { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: disconnecting revokes the org's live Google grant — a
  // destructive action that requires a fresh session.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const conn = await prisma.googleConnection.findFirst({
    where: { id: body.data.connectionId, organizationId: auth.user.organizationId },
  });
  if (!conn) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Only connections of teams the caller administers can be disconnected
  // (SUPER_ADMIN excepted) — audit AUTH-8/API-3.
  const visible = await assertConnectionVisible(auth.user, conn).then(
    () => true,
    () => false,
  );
  if (!visible) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await revokeConnection(conn.id);
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "google.connection.disconnected",
    entityType: "GoogleConnection",
    entityId: conn.id,
    details: { googleAccountEmail: conn.googleAccountEmail },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a disconnected connection into a 500.
  await invalidateOrgCache(auth.user.organizationId);
  await invalidateOrgSnapshots(auth.user.organizationId);
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("google/connections/disconnect", post);
