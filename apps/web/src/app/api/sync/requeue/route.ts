import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, requestIdOf } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { clientIpFromHeaders } from "@metricflock/shared";
import { syncJobOrgWhere } from "@/lib/sync-scope";
import { enqueue, QUEUE_BY_SYNC_TYPE, JOB_PRIORITY } from "@metricflock/jobs";
import { z } from "zod";

const schema = z.object({ jobId: z.string().min(1) });

// Admin requeue path for dead-lettered sync jobs (Stage 8, OPS-4):
// re-enqueues the retained payload and flips the bookkeeping row back
// to PENDING so the worker updates the same row (syncJobRowId).
async function post(req: NextRequest) {
  const auth = await requireApiAuth(undefined, { req });
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // A-SEC-01: the org check is part of the lookup itself (findFirst with
  // the website → organizationId scope), so a foreign jobId is
  // indistinguishable from a missing one (404) and there is no window
  // between loading the row and acting on it.
  const row = await prisma.analyticsSyncJob.findFirst({
    where: { id: body.data.jobId, ...syncJobOrgWhere(auth.user.organizationId) },
  });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "FAILED")
    return NextResponse.json({ error: "invalid_state", status: row.status }, { status: 409 });
  const queue = QUEUE_BY_SYNC_TYPE[row.type];
  if (!queue) return NextResponse.json({ error: "unknown_job_type", type: row.type }, { status: 422 });
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  // BullMQ custom jobIds may contain ":" only as exactly 3 colon-separated
  // parts (legacy compat check) — the enqueue default embeds JSON, which
  // would throw. Explicit 3-part id, unique per requeue.
  const job = await enqueue(
    queue,
    { ...payload, syncJobRowId: row.id },
    { jobId: `requeue:${row.id}:${Date.now()}`, priority: JOB_PRIORITY.REQUEUE },
  );
  if (!job) return NextResponse.json({ error: "queue_unavailable" }, { status: 503 });
  await prisma.analyticsSyncJob.update({
    where: { id: row.id },
    data: { status: "PENDING", externalId: String(job.id), lastError: null },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    requestId: requestIdOf(req),
    action: "sync.job.requeued",
    entityType: "AnalyticsSyncJob",
    entityId: row.id,
    details: { type: row.type, websiteId: row.websiteId, queue },
  });
  return NextResponse.json({ status: "ok", jobId: row.id, queue });
}

export const POST = withApiErrors("sync/requeue", post);
