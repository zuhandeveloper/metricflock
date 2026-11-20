import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@metricflock/auth";
import { hasPermission } from "@metricflock/auth";
import { assertWebsiteAccess } from "@metricflock/auth";
import { enqueue, SYNC_TYPE_BY_QUEUE } from "@metricflock/jobs";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { z } from "zod";
const schema = z.object({
  websiteId: z.string().min(1),
  type: z.enum([
    "ga4-historical-sync",
    "search-console-sync",
    "adsense-sync",
    "ad-manager-sync",
    "integration-health-check",
  ]),
});
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(user.role, "analytics.view")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await assertWebsiteAccess(user, body.data.websiteId).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const job = await enqueue(
    body.data.type,
    { websiteId: website.id },
    { jobId: `${body.data.type}:${website.id}:${new Date().toISOString().slice(0, 13)}` },
  );
  await prisma.analyticsSyncJob.create({
    data: {
      websiteId: website.id,
      type: SYNC_TYPE_BY_QUEUE[body.data.type],
      status: job ? "PENDING" : "FAILED",
      lastError: job ? null : "Redis unavailable — sync queued in DB only",
    },
  });
  await writeAudit({
    organizationId: user.organizationId,
    actorId: user.id,
    action: "sync.triggered",
    entityType: "Website",
    entityId: website.id,
    details: { type: body.data.type },
  });
  return NextResponse.json({ status: "ok", queued: !!job });
}
