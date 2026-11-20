import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { revokeConnection } from "@metricflock/google/tokens";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateOrgCache } from "@metricflock/shared";
import { z } from "zod";
const schema = z.object({ connectionId: z.string().min(1) });
export async function POST(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const conn = await prisma.googleConnection.findFirst({
    where: { id: body.data.connectionId, organizationId: auth.user.organizationId },
  });
  if (!conn) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await revokeConnection(conn.id);
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "google.connection.disconnected",
    entityType: "GoogleConnection",
    entityId: conn.id,
    details: { googleAccountEmail: conn.googleAccountEmail },
  });
  await invalidateOrgCache(auth.user.organizationId);
  return NextResponse.json({ status: "ok" });
}
