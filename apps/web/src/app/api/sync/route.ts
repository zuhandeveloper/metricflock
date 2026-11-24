import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { getSessionUser, requireAuthedRateLimit } from "@metricflock/auth";
import { hasPermission } from "@metricflock/auth";
import { assertWebsiteAccess } from "@metricflock/auth";
import { enqueue, SYNC_TYPE_BY_QUEUE, JOB_PRIORITY } from "@metricflock/jobs";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";
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
async function post(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(user.role, "analytics.view")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  // A-SEC-07: manual sync is a quota-burn vector (a viewer can enqueue
  // provider work) — strict per-user-per-route limit before any row is
  // created or job enqueued.
  const limited = await requireAuthedRateLimit(req, user, "strict");
  if ("error" in limited) return limited.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await assertWebsiteAccess(user, body.data.websiteId).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  // OPS-3: create the bookkeeping row first and pass its id to the worker,
  // which updates THIS row (externalId = BullMQ jobId) instead of creating
  // a second one — no permanent PENDING orphans. OPS-12: when Redis is
  // unavailable the enqueue is an explicit failure, not a silent "DB only"
  // queue that nothing polls.
  const jobId = `${body.data.type}:${website.id}:${new Date().toISOString().slice(0, 13)}`;
  const row = await prisma.analyticsSyncJob.create({
    data: {
      websiteId: website.id,
      type: SYNC_TYPE_BY_QUEUE[body.data.type],
      status: "PENDING",
      externalId: jobId,
      payload: { websiteId: website.id, manual: true },
    },
  });
  const job = await enqueue(
    body.data.type,
    { websiteId: website.id, syncJobRowId: row.id },
    { jobId, priority: JOB_PRIORITY.MANUAL },
  );
  if (!job) {
    await prisma.analyticsSyncJob.update({
      where: { id: row.id },
      data: { status: "FAILED", lastError: "Redis unavailable — sync could not be queued" },
    });
    return NextResponse.json({ error: "queue_unavailable" }, { status: 503 });
  }
  await writeAudit({
    organizationId: user.organizationId,
    actorId: user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "sync.triggered",
    entityType: "Website",
    entityId: website.id,
    details: { type: body.data.type },
  });
  return NextResponse.json({ status: "ok", queued: !!job });
}

export const POST = withApiErrors("sync", post);
