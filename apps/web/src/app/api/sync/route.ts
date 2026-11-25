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
  // A-FE-07: the manual list used to omit ga4-realtime-sync and
  // analytics-cache-refresh, so there was no manual realtime refresh even
  // though the worker handles both queues (and SYNC_TYPE_BY_QUEUE maps
  // them). Both are manual-triggerable now; the A-API-06 hour-bucket
  // dedup applies uniformly — the scheduler already refreshes realtime
  // every ~5 min, so a second manual realtime click in the same hour
  // honestly answers already_queued / already_completed.
  type: z.enum([
    "ga4-realtime-sync",
    "ga4-historical-sync",
    "search-console-sync",
    "adsense-sync",
    "ad-manager-sync",
    "analytics-cache-refresh",
    "integration-health-check",
  ]),
});

type QueueType = keyof typeof SYNC_TYPE_BY_QUEUE;
type ExistingSyncRow = NonNullable<Awaited<ReturnType<typeof prisma.analyticsSyncJob.findFirst>>>;

// A-API-06: manual sync is idempotent-by-design within a UTC hour. The
// hour bucket is the dedup key (the row's externalId is the deterministic
// `${type}:${websiteId}:${hour}` jobId). A second POST for the same
// website+type in the same hour returns the existing row instead of
// failing on the unique externalId with a generic 409, and a FAILED row
// can be retried in the same hour with a fresh BullMQ jobId — reusing
// the hour jobId would dedupe against the retained failed job in BullMQ
// (the requeue route does the same with `requeue:<rowId>:<ts>`).
async function handleExistingRow(
  req: NextRequest,
  organizationId: string,
  actorId: string,
  websiteId: string,
  queue: QueueType,
  row: ExistingSyncRow,
): Promise<NextResponse> {
  if (row.status === "PENDING" || row.status === "RUNNING" || row.status === "RETRYING") {
    return NextResponse.json({ status: "already_queued", queued: true, syncJobId: row.id });
  }
  if (row.status === "SUCCEEDED") {
    return NextResponse.json({ status: "already_completed", queued: false, syncJobId: row.id });
  }
  // FAILED: re-enqueue the same row (no new row, no second queue entry
  // for the hour) with a fresh jobId.
  const job = await enqueue(
    queue,
    { websiteId, syncJobRowId: row.id },
    { jobId: `retry:${row.id}:${Date.now()}`, priority: JOB_PRIORITY.MANUAL },
  );
  if (!job) return NextResponse.json({ error: "queue_unavailable" }, { status: 503 });
  await prisma.analyticsSyncJob.update({
    where: { id: row.id },
    data: { status: "PENDING", externalId: String(job.id), lastError: null },
  });
  await writeAudit({
    organizationId,
    actorId,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "sync.triggered",
    entityType: "Website",
    entityId: websiteId,
    details: { type: queue, retried: true },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a triggered sync into a 500.
  return NextResponse.json({ status: "ok", queued: true });
}

async function post(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // A-API-06: triggering a sync burns provider quota — it is a
  // manage-level action (website.manage: SUPER_ADMIN + TEAM_ADMIN), not
  // analytics.view (any viewer, incl. TEAM_MEMBER).
  if (!hasPermission(user.role, "website.manage")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  const hour = new Date().toISOString().slice(0, 13);
  const hourStart = new Date(`${hour}:00:00.000Z`);
  const jobId = `${body.data.type}:${website.id}:${hour}`;
  const type = SYNC_TYPE_BY_QUEUE[body.data.type];
  // A-API-06: dedup by (website, type, UTC hour) — this also catches a
  // row whose externalId changed on retry, and a scheduled row for the
  // same hour (a sync is genuinely already queued/running then).
  const findExisting = () =>
    prisma.analyticsSyncJob.findFirst({
      where: { websiteId: website.id, type, createdAt: { gte: hourStart } },
      orderBy: { createdAt: "desc" },
    });
  const existing = await findExisting();
  if (existing) {
    return handleExistingRow(req, user.organizationId, user.id, website.id, body.data.type, existing);
  }
  let row;
  try {
    row = await prisma.analyticsSyncJob.create({
      data: {
        websiteId: website.id,
        type,
        status: "PENDING",
        externalId: jobId,
        payload: { websiteId: website.id, manual: true },
      },
    });
  } catch (e) {
    // Race: two concurrent POSTs can both pass the lookup above; the
    // unique externalId then rejects the second insert (P2002). Map that
    // race to the same stable already_queued contract — the transfer
    // route does the same for its open-transfer race.
    if ((e as { code?: string }).code === "P2002") {
      const raced = await findExisting();
      if (raced) {
        return handleExistingRow(req, user.organizationId, user.id, website.id, body.data.type, raced);
      }
    }
    throw e;
  }
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
  }).catch(() => undefined); // A-API-04: audit failure must not turn a triggered sync into a 500.
  return NextResponse.json({ status: "ok", queued: true });
}

export const POST = withApiErrors("sync", post);
